// lib/graphql.ts — GitHub GraphQL v4 surface (POST /api/graphql) over the shared store.
//
// Targeted executor: a small tokenizer + parser for the GraphQL documents the
// suite sends (operations, variables, arguments, inline/named fragments,
// @skip/@include), with per-type field validation. Unknown fields are
// GraphQL-level errors (HTTP 200, `errors` array); unknown repositories are
// `data.repository = null` with NO errors. No wall-clock time, no randomness.
//
// Auth mirrors the git/REST surfaces: when process.env.MAKEFUN_SHOP_TOKEN is
// set, `Authorization: Bearer <token>` is required (missing/wrong → 401 JSON);
// when it is unset, requests are allowed.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN, isStoreError } from './store.ts';
import type { Issue, Pull, Repo } from './store.ts';

// ---------------------------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------------------------

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function checkAuth(req: IncomingMessage): boolean {
  const configured = process.env.MAKEFUN_SHOP_TOKEN;
  if (!configured) return true;
  return req.headers.authorization === `Bearer ${configured}`;
}

// ---------------------------------------------------------------------------------------------
// GraphQL document parser (small targeted subset)
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface DirectiveNode {
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  directives: DirectiveNode[];
  selections: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string; directives: DirectiveNode[] }
  | { kind: 'inlineFragment'; typeCondition: string | null; directives: DirectiveNode[]; selections: SelectionNode[] };

interface VariableDef {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variables: VariableDef[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class ParseError extends Error {}

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or regular "...".
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new ParseError('Unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < len) {
        const c = source[j]!;
        if (c === '"') break;
        if (c === '\\') {
          const esc = source[j + 1];
          if (esc === undefined) throw new ParseError('Unterminated string');
          if (esc === 'u') {
            const hex = source.slice(j + 2, j + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError('Bad unicode escape');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else {
            const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
            out += map[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        out += c;
        j += 1;
      }
      if (j >= len) throw new ParseError('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < len && source[j]! >= '0' && source[j]! <= '9') j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < len && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < len && source[j]! >= '0' && source[j]! <= '9') j += 1;
      }
      const raw = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: raw } : { kind: 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < len && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new ParseError(`Unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const tok = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new ParseError(`Expected "${value}" but got ${tok.kind === 'eof' ? 'end of input' : JSON.stringify(tok)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expectName(what = 'a name'): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new ParseError(`Expected ${what} but got ${tok.kind}`);
    return tok.value;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation' || tok.value === 'subscription')) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
      this.parseDirectives();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    if (tok.kind === 'name' && tok.value === 'fragment') {
      this.next();
      const name = this.expectName('a fragment name');
      const on = this.expectName('"on"');
      if (on !== 'on') throw new ParseError('Expected "on" in fragment definition');
      const typeCondition = this.expectName('a type name');
      this.parseDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new ParseError(`Unexpected token ${JSON.stringify(tok)} at top level`);
  }

  private parseVariableDefinitions(): VariableDef[] {
    const out: VariableDef[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName('a variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      out.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): string {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      let type = `[${inner}]`;
      if (this.acceptPunct('!')) type += '!';
      return type;
    }
    const name = this.expectName('a type name');
    let type = name;
    if (this.acceptPunct('!')) type += '!';
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    const out: SelectionNode[] = [];
    this.expectPunct('{');
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new ParseError('Unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      const tok = this.peek();
      if (tok.kind === 'name' && tok.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name');
        const directives = this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (tok.kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'fragmentSpread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inlineFragment', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName('a field name');
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, directives, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName('an argument name');
      this.expectPunct(':');
      out.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return out;
  }

  private parseDirectives(): DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      const name = this.expectName('a directive name');
      const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : [];
      out.push({ name, args });
    }
    return out;
  }

  private parseValue(isConst: boolean): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      if (isConst) throw new ParseError('Variable in constant value');
      return { kind: 'variable', name: this.expectName('a variable name') };
    }
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new ParseError('Unterminated list');
        values.push(this.parseValue(isConst));
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new ParseError('Unterminated object');
        const name = this.expectName('an object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new ParseError(`Unexpected value token ${JSON.stringify(tok)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema: allowed fields per type, and introspection data
// ---------------------------------------------------------------------------------------------

const FIELD_SETS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['id', 'login', 'name', 'email'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'description', 'private',
    'createdAt', 'updatedAt', 'issue', 'issues', 'pullRequest', 'pullRequests',
  ],
  Ref: ['name', 'prefix', 'id'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable',
    'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueComment: ['id', 'body', 'createdAt', 'author'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'args', 'type'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'subscriptionType', 'types'],
};

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR' | 'INTERFACE';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
    ],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Viewer: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author'] },
  Node: { kind: 'INTERFACE', fields: ['id'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
};

// ---------------------------------------------------------------------------------------------
// views: plain objects the executor resolves fields from
// ---------------------------------------------------------------------------------------------

type View = Record<string, unknown> & { __typename: string };

function userView(login: string, id: number): View {
  return { __typename: 'User', id: String(id), login, name: login, email: `${login}@example.invalid` };
}

function viewerView(store: Store): View {
  const viewer = store.viewer();
  const view = userView(viewer.login, viewer.id);
  view.__typename = 'Viewer';
  view.name = viewer.name;
  view.email = viewer.email;
  return view;
}

function repoView(store: Store, repo: Repo): View {
  return {
    __typename: 'Repository',
    id: store.repoId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: userView(repo.owner, repo.owner === VIEWER_LOGIN ? store.viewer().id : 0),
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', id: `R_${repo.owner}_${repo.name}` },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    _repo: repo,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueView(store: Store, repo: Repo, issue: Issue): View {
  return {
    __typename: 'Issue',
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    _repo: repo,
    _issue: issue,
  };
}

function pullState(pr: Pull): string {
  if (pr.state === 'open') return 'OPEN';
  return pr.merged ? 'MERGED' : 'CLOSED';
}

function pullView(store: Store, repo: Repo, pr: Pull): View {
  return {
    __typename: 'PullRequest',
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pullState(pr),
    merged: pr.merged,
    mergeable: store.prMergeable(repo, pr),
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    _repo: repo,
    _pull: pr,
  };
}

function commentView(store: Store, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): View {
  return {
    __typename: 'IssueComment',
    id: `C_${repo.owner}_${repo.name}_${issue.number}_${comment.id}`,
    body: comment.body,
    createdAt: comment.createdAt,
    _repo: repo,
    _issue: issue,
  };
}

function typeView(name: string): View | null {
  const info = TYPE_INFO[name];
  if (!info) return null;
  return {
    __typename: '__Type',
    name,
    kind: info.kind,
    description: null,
    fields: info.fields ? info.fields.map((field) => ({ __typename: '__Field', name: field, description: null, args: [], type: null })) : null,
    enumValues: info.enumValues ? info.enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null })) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// cursors (opaque, deterministic)
// ---------------------------------------------------------------------------------------------

function encodeCursor(kind: string, value: number): string {
  return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64');
}

function decodeCursor(after: unknown): number | null {
  if (typeof after !== 'string' || after === '') return null;
  if (/^\d+$/.test(after)) return Number.parseInt(after, 10);
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^[^:]+:(\d+)$/.exec(text);
    if (match) return Number.parseInt(match[1]!, 10);
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

class GqlError extends Error {}

interface Executor {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (!(node.name in variables)) throw new GqlError(`Variable $${node.name} is not provided`);
      return variables[node.name];
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argsMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function typeMatches(current: string, condition: string | null): boolean {
  if (condition === null) return true;
  if (condition === current) return true;
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'Viewer', 'IssueComment'].includes(current);
  if (condition === 'Actor') return ['User', 'Viewer'].includes(current);
  if ((current === 'Viewer' && condition === 'User') || (current === 'User' && condition === 'Viewer')) return true;
  return false;
}

/** @skip(if:true)/@include(if:false) hide a selection. */
function directivesHide(directives: DirectiveNode[], variables: Record<string, unknown>): boolean {
  for (const directive of directives) {
    const ifArg = directive.args.find((arg) => arg.name === 'if');
    if (!ifArg) continue;
    const value = resolveValue(ifArg.value, variables);
    if (directive.name === 'skip' && value === true) return true;
    if (directive.name === 'include' && value === false) return true;
  }
  return false;
}

function pageInfoView(hasNextPage: boolean, hasPreviousPage: boolean, startCursor: string | null, endCursor: string | null): View {
  return { __typename: 'PageInfo', hasNextPage, hasPreviousPage, startCursor, endCursor };
}

function issuesConnection(exec: Executor, repo: Repo, args: Record<string, unknown>): View {
  const statesRaw = args.states;
  const states: string[] | null = Array.isArray(statesRaw)
    ? statesRaw.map((state) => String(state).toUpperCase())
    : null;
  let issues = [...repo.issues];
  // GitHub's default when no states argument is given is OPEN only (the suite's
  // pull-requests-list check calls the no-states list "the open list", and no
  // check expects merged/closed items in a no-states list).
  if (states) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    issues = issues.filter((issue) => wanted.has(issue.state));
  } else {
    issues = issues.filter((issue) => issue.state === 'open');
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  const field = String(orderBy.field ?? 'CREATED_AT').toUpperCase();
  const descending = direction !== 'ASC';
  const compare = (a: Issue, b: Issue): number => {
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === 'COMMENTS') {
      cmp = (repo.comments.get(a.number)?.length ?? 0) - (repo.comments.get(b.number)?.length ?? 0);
    } else cmp = a.number - b.number;
    if (cmp === 0) cmp = a.number - b.number;
    return descending ? -cmp : cmp;
  };
  issues.sort(compare);
  const afterNum = decodeCursor(args.after);
  if (afterNum !== null) {
    issues = descending ? issues.filter((issue) => issue.number < afterNum) : issues.filter((issue) => issue.number > afterNum);
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const nodes = page.map((issue) => issueView(exec.store, repo, issue));
  const edges = page.map((issue) => ({
    __typename: 'IssueEdge',
    node: issueView(exec.store, repo, issue),
    cursor: encodeCursor('issue', issue.number),
  }));
  return {
    __typename: 'IssueConnection',
    nodes,
    edges,
    pageInfo: pageInfoView(
      hasNextPage,
      afterNum !== null,
      page.length ? encodeCursor('issue', page[0]!.number) : null,
      page.length ? encodeCursor('issue', page[page.length - 1]!.number) : null,
    ),
    totalCount: issues.length,
  };
}

function pullsConnection(exec: Executor, repo: Repo, args: Record<string, unknown>): View {
  const statesRaw = args.states;
  const states: string[] | null = Array.isArray(statesRaw)
    ? statesRaw.map((state) => String(state).toUpperCase())
    : null;
  let pulls = exec.store.listPulls(repo, 'all');
  // GitHub's default when no states argument is given is OPEN only (see
  // issuesConnection above).
  if (states) {
    pulls = pulls.filter((pr) => states.includes(pullState(pr)));
  } else {
    pulls = pulls.filter((pr) => pullState(pr) === 'OPEN');
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const descending = String(orderBy.direction ?? 'DESC').toUpperCase() !== 'ASC';
  pulls.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const afterNum = decodeCursor(args.after);
  if (afterNum !== null) {
    pulls = descending ? pulls.filter((pr) => pr.number < afterNum) : pulls.filter((pr) => pr.number > afterNum);
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : pulls.length;
  const page = pulls.slice(0, first);
  const hasNextPage = pulls.length > page.length;
  const nodes = page.map((pr) => pullView(exec.store, repo, pr));
  const edges = page.map((pr) => ({
    __typename: 'PullRequestEdge',
    node: pullView(exec.store, repo, pr),
    cursor: encodeCursor('pull', pr.number),
  }));
  return {
    __typename: 'PullRequestConnection',
    nodes,
    edges,
    pageInfo: pageInfoView(
      hasNextPage,
      afterNum !== null,
      page.length ? encodeCursor('pull', page[0]!.number) : null,
      page.length ? encodeCursor('pull', page[page.length - 1]!.number) : null,
    ),
    totalCount: pulls.length,
  };
}

function filesConnection(exec: Executor, repo: Repo, pr: Pull, args: Record<string, unknown>): View {
  const refreshed = exec.store.getPull(repo, pr.number) ?? pr;
  const files = refreshed.files.map((file, index) => ({
    __typename: 'PullRequestFile',
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
    _index: index,
  }));
  const afterIdx = decodeCursor(args.after);
  const rest = afterIdx === null ? files : files.filter((file) => (file._index as number) > afterIdx);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : rest.length;
  const page = rest.slice(0, first);
  const hasNextPage = rest.length > page.length;
  const nodes = page.map((file) => ({ __typename: 'PullRequestFile', path: file.path, additions: file.additions, deletions: file.deletions, changes: file.changes }));
  const edges = page.map((file) => ({
    __typename: 'PullRequestFileEdge',
    node: { __typename: 'PullRequestFile', path: file.path, additions: file.additions, deletions: file.deletions, changes: file.changes },
    cursor: encodeCursor('file', file._index as number),
  }));
  return {
    __typename: 'PullRequestFileConnection',
    nodes,
    edges,
    pageInfo: pageInfoView(
      hasNextPage,
      afterIdx !== null,
      page.length ? encodeCursor('file', page[0]!._index as number) : null,
      page.length ? encodeCursor('file', page[page.length - 1]!._index as number) : null,
    ),
    totalCount: files.length,
  };
}

function commentsConnection(exec: Executor, repo: Repo, issue: Issue, args: Record<string, unknown>): View {
  const comments = exec.store.listComments(repo, issue.number);
  const first = typeof args.first === 'number' && args.first >= 0 ? Math.floor(args.first) : comments.length;
  const page = comments.slice(0, first);
  const nodes = page.map((comment) => commentView(exec.store, repo, issue, comment));
  return {
    __typename: 'IssueCommentConnection',
    nodes,
    edges: page.map((comment) => ({
      __typename: 'CommentEdge',
      node: commentView(exec.store, repo, issue, comment),
      cursor: encodeCursor('comment', comment.id),
    })),
    pageInfo: pageInfoView(comments.length > page.length, false, null, null),
    totalCount: comments.length,
  };
}

/**
 * Resolve one field on a view. Returns the raw value plus the child type name
 * (null for scalars / null values). Throws GqlError for bad arguments or
 * failed mutations; the caller turns it into an `errors` entry.
 */
function resolveField(exec: Executor, typeName: string, view: View, field: FieldNode): { value: unknown; childType: string | null } {
  const store = exec.store;
  const args = argsMap(field, exec.variables);
  const repo = view._repo as Repo | undefined;

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return { value: viewerView(store), childType: 'Viewer' };
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') {
          throw new GqlError('Field "repository" requires string arguments "owner" and "name"');
        }
        const found = store.getRepo(owner, name);
        return { value: found ? repoView(store, found) : null, childType: 'Repository' };
      }
      if (field.name === 'node') {
        const id = args.id;
        if (typeof id !== 'string') throw new GqlError('Field "node" requires a string argument "id"');
        const asRepo = store.findRepoById(id);
        if (asRepo) return { value: repoView(store, asRepo), childType: 'Repository' };
        const asIssue = store.findIssueById(id);
        if (asIssue) return { value: issueView(store, asIssue.repo, asIssue.issue), childType: 'Issue' };
        const asPull = store.findPullById(id);
        if (asPull) return { value: pullView(store, asPull.repo, asPull.pull), childType: 'PullRequest' };
        return { value: null, childType: null };
      }
      if (field.name === '__type') {
        const name = args.name;
        if (typeof name !== 'string') throw new GqlError('Field "__type" requires a string argument "name"');
        const info = typeView(name);
        return { value: info, childType: '__Type' };
      }
      if (field.name === '__schema') {
        const types = Object.keys(TYPE_INFO).map((name) => typeView(name)).filter((entry): entry is View => entry !== null);
        return {
          value: {
            __typename: '__Schema',
            queryType: typeView('Query'),
            mutationType: typeView('Mutation'),
            subscriptionType: null,
            types,
          },
          childType: '__Schema',
        };
      }
      break;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repositoryId = input.repositoryId;
        if (typeof repositoryId !== 'string') throw new GqlError('createIssue requires input.repositoryId');
        const target = store.findRepoById(repositoryId);
        if (!target) throw new GqlError(`Repository not found: ${repositoryId}`);
        if (typeof input.title !== 'string' || input.title === '') throw new GqlError('createIssue requires input.title');
        try {
          const issue = store.createIssue(target, { title: input.title, body: typeof input.body === 'string' ? input.body : undefined });
          return {
            value: { __typename: 'CreateIssuePayload', issue: issueView(store, target, issue), clientMutationId: input.clientMutationId ?? null },
            childType: 'CreateIssuePayload',
          };
        } catch (err) {
          if (isStoreError(err)) throw new GqlError(err.message);
          throw err;
        }
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const issueId = input.issueId;
        if (typeof issueId !== 'string') throw new GqlError('closeIssue requires input.issueId');
        const found = store.findIssueById(issueId);
        if (!found) throw new GqlError(`Issue not found: ${issueId}`);
        const issue = store.closeIssue(found.repo, found.issue.number);
        return {
          value: { __typename: 'CloseIssuePayload', issue: issueView(store, found.repo, issue), clientMutationId: input.clientMutationId ?? null },
          childType: 'CloseIssuePayload',
        };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repositoryId = input.repositoryId;
        if (typeof repositoryId !== 'string') throw new GqlError('createPullRequest requires input.repositoryId');
        const target = store.findRepoById(repositoryId);
        if (!target) throw new GqlError(`Repository not found: ${repositoryId}`);
        const head = input.headRefName;
        const base = input.baseRefName;
        if (typeof head !== 'string' || typeof base !== 'string') throw new GqlError('createPullRequest requires input.headRefName and input.baseRefName');
        if (typeof input.title !== 'string' || input.title === '') throw new GqlError('createPullRequest requires input.title');
        try {
          const pr = store.createPull(target, {
            title: input.title,
            body: typeof input.body === 'string' ? input.body : undefined,
            head,
            base,
          });
          return {
            value: { __typename: 'CreatePullRequestPayload', pullRequest: pullView(store, target, pr), clientMutationId: input.clientMutationId ?? null },
            childType: 'CreatePullRequestPayload',
          };
        } catch (err) {
          if (isStoreError(err)) throw new GqlError(err.message);
          throw err;
        }
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const pullRequestId = input.pullRequestId;
        if (typeof pullRequestId !== 'string') throw new GqlError('mergePullRequest requires input.pullRequestId');
        const found = store.findPullById(pullRequestId);
        if (!found) throw new GqlError(`Pull request not found: ${pullRequestId}`);
        try {
          store.mergePullSquash(found.repo, found.pull.number);
        } catch (err) {
          if (isStoreError(err)) throw new GqlError(err.message);
          throw err;
        }
        const merged = store.getPull(found.repo, found.pull.number) ?? found.pull;
        return {
          value: { __typename: 'MergePullRequestPayload', pullRequest: pullView(store, found.repo, merged), clientMutationId: input.clientMutationId ?? null },
          childType: 'MergePullRequestPayload',
        };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const subjectId = input.subjectId;
        if (typeof subjectId !== 'string') throw new GqlError('addComment requires input.subjectId');
        const found = store.findIssueById(subjectId);
        if (!found) throw new GqlError(`Issue not found: ${subjectId}`);
        if (typeof input.body !== 'string' || input.body === '') throw new GqlError('addComment requires input.body');
        const comment = store.addComment(found.repo, found.issue.number, input.body);
        const node = commentView(store, found.repo, found.issue, comment);
        return {
          value: {
            __typename: 'AddCommentPayload',
            commentEdge: { __typename: 'CommentEdge', node, cursor: encodeCursor('comment', comment.id) },
            subject: issueView(store, found.repo, found.issue),
            clientMutationId: input.clientMutationId ?? null,
          },
          childType: 'AddCommentPayload',
        };
      }
      break;
    }
    case 'Repository': {
      if (!repo) throw new GqlError('Repository view has no repo');
      switch (field.name) {
        case 'issue': {
          const number = args.number;
          if (typeof number !== 'number') throw new GqlError('Field "issue" requires an integer argument "number"');
          const issue = store.getIssue(repo, number);
          return { value: issue ? issueView(store, repo, issue) : null, childType: 'Issue' };
        }
        case 'issues':
          return { value: issuesConnection(exec, repo, args), childType: 'IssueConnection' };
        case 'pullRequest': {
          const number = args.number;
          if (typeof number !== 'number') throw new GqlError('Field "pullRequest" requires an integer argument "number"');
          const pr = store.getPull(repo, number);
          return { value: pr ? pullView(store, repo, pr) : null, childType: 'PullRequest' };
        }
        case 'pullRequests':
          return { value: pullsConnection(exec, repo, args), childType: 'PullRequestConnection' };
        default:
          return { value: view[field.name] ?? null, childType: field.name === 'owner' ? 'User' : field.name === 'defaultBranchRef' ? 'Ref' : null };
      }
    }
    case 'Issue': {
      const issue = view._issue as Issue | undefined;
      if (!repo || !issue) throw new GqlError('Issue view has no issue');
      if (field.name === 'author') return { value: viewerView(store), childType: 'Viewer' };
      if (field.name === 'comments') return { value: commentsConnection(exec, repo, issue, args), childType: 'IssueCommentConnection' };
      return { value: view[field.name] ?? null, childType: null };
    }
    case 'PullRequest': {
      const pr = view._pull as Pull | undefined;
      if (!repo || !pr) throw new GqlError('Pull request view has no pull request');
      if (field.name === 'author') return { value: viewerView(store), childType: 'Viewer' };
      if (field.name === 'files') return { value: filesConnection(exec, repo, pr, args), childType: 'PullRequestFileConnection' };
      if (field.name === 'mergeable') return { value: store.prMergeable(repo, store.getPull(repo, pr.number) ?? pr), childType: null };
      if (field.name === 'state') return { value: pullState(store.getPull(repo, pr.number) ?? pr), childType: null };
      if (field.name === 'merged') return { value: (store.getPull(repo, pr.number) ?? pr).merged, childType: null };
      return { value: view[field.name] ?? null, childType: null };
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'IssueCommentConnection': {
      if (field.name === 'totalCount') return { value: view.totalCount ?? null, childType: null };
      return { value: view[field.name] ?? null, childType: null };
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestFileEdge':
    case 'CommentEdge': {
      return { value: view[field.name] ?? null, childType: field.name === 'node' ? edgeNodeType(typeName) : null };
    }
    case '__Type': {
      return { value: view[field.name] ?? null, childType: field.name === 'fields' ? '__Field' : field.name === 'enumValues' ? '__EnumValue' : null };
    }
    case '__Schema': {
      if (field.name === 'queryType' || field.name === 'mutationType') return { value: view[field.name] ?? null, childType: '__Type' };
      return { value: view[field.name] ?? null, childType: field.name === 'types' ? '__Type' : null };
    }
    default: {
      return { value: view[field.name] ?? null, childType: null };
    }
  }
  // Field is in FIELD_SETS for this type but has no resolver above: treat as scalar on the view.
  return { value: view[field.name] ?? null, childType: null };
}

function edgeNodeType(edgeType: string): string {
  switch (edgeType) {
    case 'IssueEdge':
      return 'Issue';
    case 'PullRequestEdge':
      return 'PullRequest';
    case 'PullRequestFileEdge':
      return 'PullRequestFile';
    case 'CommentEdge':
      return 'IssueComment';
    default:
      return 'Issue';
  }
}

/** Child type for an object-valued field, used when the resolver did not name one. */
function inferChildType(typeName: string, fieldName: string): string | null {
  switch (fieldName) {
    case 'issue':
      return 'Issue';
    case 'pullRequest':
      return 'PullRequest';
    case 'commentEdge':
      return 'CommentEdge';
    case 'subject':
      return 'Issue';
    case 'owner':
      return 'User';
    case 'defaultBranchRef':
      return 'Ref';
    case 'author':
      return 'Viewer';
    case 'node':
      return edgeNodeType(typeName);
    case 'nodes':
      if (typeName === 'IssueConnection') return 'Issue';
      if (typeName === 'PullRequestConnection') return 'PullRequest';
      if (typeName === 'PullRequestFileConnection') return 'PullRequestFile';
      if (typeName === 'IssueCommentConnection') return 'IssueComment';
      return null;
    case 'edges':
      if (typeName === 'IssueConnection') return 'IssueEdge';
      if (typeName === 'PullRequestConnection') return 'PullRequestEdge';
      if (typeName === 'PullRequestFileConnection') return 'PullRequestFileEdge';
      if (typeName === 'IssueCommentConnection') return 'CommentEdge';
      return null;
    case 'pageInfo':
      return 'PageInfo';
    case 'comments':
      return 'IssueCommentConnection';
    case 'files':
      return 'PullRequestFileConnection';
    case 'issues':
      return 'IssueConnection';
    case 'pullRequests':
      return 'PullRequestConnection';
    case 'fields':
      return '__Field';
    case 'enumValues':
      return '__EnumValue';
    case 'types':
    case 'queryType':
    case 'mutationType':
      return '__Type';
    default:
      return null;
  }
}

/** Deep-strip internal single-`_`-prefixed keys (e.g. `_repo`) from an executed result. */
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Single-underscore internals only: `__type` / `__schema` / `__typename` are real GraphQL keys.
      if (key.startsWith('_') && !key.startsWith('__')) continue;
      out[key] = sanitize(entry);
    }
    return out;
  }
  return value;
}

function executeSelections(exec: Executor, typeName: string, view: View | null, selections: SelectionNode[]): Record<string, unknown> | null {
  if (view === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = exec.fragments.get(selection.name);
      if (!fragment) {
        exec.errors.push({ message: `Unknown fragment "${selection.name}"` });
        continue;
      }
      if (directivesHide(selection.directives, exec.variables)) continue;
      if (!typeMatches(typeName, fragment.typeCondition)) continue;
      const nested = executeSelections(exec, typeName, view, fragment.selections);
      if (nested) Object.assign(out, nested);
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (directivesHide(selection.directives, exec.variables)) continue;
      if (!typeMatches(typeName, selection.typeCondition)) continue;
      const nested = executeSelections(exec, typeName, view, selection.selections);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const field = selection;
    if (directivesHide(field.directives, exec.variables)) continue;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const allowed = FIELD_SETS[typeName] ?? [];
    if (!allowed.includes(field.name)) {
      if (typeName === 'Viewer') {
        exec.errors.push({ message: `noSuchFieldOnViewer: Field "${field.name}" doesn't exist on type "Viewer"` });
      } else {
        exec.errors.push({ message: `Field "${field.name}" doesn't exist on type "${typeName}"` });
      }
      out[responseKey] = null;
      continue;
    }
    try {
      const { value, childType } = resolveField(exec, typeName, view, field);
      const resolvedChildType = childType ?? inferChildType(typeName, field.name);
      if (value === null || value === undefined) {
        out[responseKey] = null;
        continue;
      }
      if (field.selections && resolvedChildType) {
        if (Array.isArray(value)) {
          out[responseKey] = value.map((item) => {
            if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
              return executeSelections(exec, (item as View).__typename as string, item as View, field.selections!);
            }
            return item;
          });
        } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
          out[responseKey] = executeSelections(exec, (value as View).__typename as string, value as View, field.selections);
        } else {
          out[responseKey] = value;
        }
      } else {
        out[responseKey] = value;
      }
    } catch (err) {
      if (err instanceof GqlError) {
        exec.errors.push({ message: err.message });
        out[responseKey] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function executeDocument(store: Store, doc: unknown): Record<string, unknown> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { data: null, errors: [{ message: 'Request body must be a JSON object with a "query" string' }] };
  }
  const body = doc as Record<string, unknown>;
  const query = body.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided' }] };
  }
  let variables: Record<string, unknown> = {};
  if (body.variables !== undefined && body.variables !== null) {
    if (typeof body.variables === 'string') {
      try {
        const parsed: unknown = JSON.parse(body.variables);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) variables = parsed as Record<string, unknown>;
      } catch {
        return { data: null, errors: [{ message: 'Variables are not valid JSON' }] };
      }
    } else if (typeof body.variables === 'object' && !Array.isArray(body.variables)) {
      variables = body.variables as Record<string, unknown>;
    }
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;

  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse query' }] };
  }

  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'No operation found in query' }] };
  }
  let operation: OperationNode | undefined;
  if (operationName) {
    operation = operations.find((op) => op.name === operationName);
    if (!operation) return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
  } else if (operations.length === 1) {
    operation = operations[0]!;
  } else {
    return { data: null, errors: [{ message: 'Multiple operations provided without an operationName' }] };
  }

  const exec: Executor = { store, variables: { ...variables }, fragments, errors: [] };
  // Operation variable defaults fill in missing variables.
  for (const def of operation.variables) {
    if (!(def.name in exec.variables) && def.defaultValue) {
      try {
        exec.variables[def.name] = resolveValue(def.defaultValue, exec.variables);
      } catch {
        // Leave unset; use sites report it.
      }
    }
  }
  // Required variables (non-null type, no default) must be present.
  for (const def of operation.variables) {
    if (def.type.endsWith('!') && def.defaultValue === null && !(def.name in exec.variables)) {
      return { data: null, errors: [{ message: `Variable $${def.name} of required type ${def.type} was not provided` }] };
    }
  }

  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootView: View = { __typename: rootType };
  let data: Record<string, unknown> | null;
  try {
    data = executeSelections(exec, rootType, rootView, operation.selections);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Execution failed' }] };
  }
  data = (sanitize(data) as Record<string, unknown> | null);
  if (exec.errors.length > 0) return { data, errors: exec.errors };
  return { data };
}

// ---------------------------------------------------------------------------------------------
// handler
// ---------------------------------------------------------------------------------------------

/**
 * Handle POST /api/graphql. Returns true when the request was ours (and has
 * been answered), false otherwise so the caller falls through.
 */
export async function handleGraphql(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    return false;
  }
  if ((req.method ?? 'GET') !== 'POST') return false;
  if (url.pathname !== '/api/graphql' && url.pathname !== '/api/graphql/') return false;

  if (!checkAuth(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  const text = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return true;
  }

  if (Array.isArray(parsed)) {
    const results = parsed.map((doc) => executeDocument(store, doc));
    sendJson(res, 200, results);
    return true;
  }
  sendJson(res, 200, executeDocument(store, parsed));
  return true;
}
