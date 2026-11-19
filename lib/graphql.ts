// lib/graphql.ts — the GraphQL v4 surface (POST /api/graphql).
//
// A targeted executor, not a general engine: a small tokenizer and
// recursive-descent parser for the documents `gh` and `github-mcp-server`
// send, a validator against a static schema table, and resolvers over the
// shared store. It also answers generic `__type` introspection for the
// probed names, and GitHub-style operation batching (a JSON array of
// operation documents in one body answers an array, in order).
//
// Wire rules, derived from the suite's documents:
//   - an unauthenticated request is exactly 401;
//   - an unknown field is HTTP 200 with an `errors` array naming it;
//   - an unknown repository is `data.repository = null` with no errors;
//   - issue / pull-request connections default to OPEN only;
//   - global ids are the store's own (`R_...` / `I_...` / `PR_...`),
//     stable across reads and surfaces;
//   - `issues` with orderBy {field: CREATED_AT, direction: DESC} returns
//     issue numbers in descending order, ties by number DESC.
//
// Determinism: no clock, no randomness. Cursors are base64 of a stable
// `cursor:<number>` string, so paging replays exactly.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAuthorized, nextRequestId } from './rest.ts';
import {
  isStoreError,
  Store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

class LexError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  const isDigit = (ch: string): boolean => /[0-9]/.test(ch);
  while (i < len) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < len && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or a plain "..." string.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new LexError('Unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end).replace(/\\"""/g, '"""') });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < len) {
        const c = source[j]!;
        if (c === '"') {
          closed = true;
          j += 1;
          break;
        }
        if (c === '\\') {
          const esc = source[j + 1];
          if (esc === undefined) break;
          switch (esc) {
            case '"': out += '"'; break;
            case '\\': out += '\\'; break;
            case '/': out += '/'; break;
            case 'b': out += '\b'; break;
            case 'f': out += '\f'; break;
            case 'n': out += '\n'; break;
            case 'r': out += '\r'; break;
            case 't': out += '\t'; break;
            case 'u': {
              const hex = source.slice(j + 2, j + 6);
              const code = Number.parseInt(hex, 16);
              if (!Number.isFinite(code)) throw new LexError('Bad unicode escape in string');
              out += String.fromCharCode(code);
              j += 4;
              break;
            }
            default:
              throw new LexError(`Bad escape \\${esc} in string`);
          }
          j += 2;
          continue;
        }
        out += c;
        j += 1;
      }
      if (!closed) throw new LexError('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j;
      continue;
    }
    if (isDigit(ch) || (ch === '-' && isDigit(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < len && isDigit(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < len && isDigit(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < len && isDigit(source[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i + 1;
      while (j < len && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new LexError(`Unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface VariableDefinition {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface OperationDefinition {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentDefinition {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: OperationDefinition[];
  fragments: Map<string, FragmentDefinition>;
}

class ParseError extends Error {}

/** A recursive-descent parser for the GraphQL document language. */
class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`Expected "${value}", got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new ParseError(`Expected a name, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) {
      throw new ParseError(`Expected "${value}", got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: OperationDefinition[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          kind: 'operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selections: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        operations.push(this.parseOperation());
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
        continue;
      }
      throw new ParseError(`Unexpected ${JSON.stringify(token.value)} at the top of a document`);
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationDefinition {
    const operation = this.next().value as 'query' | 'mutation' | 'subscription';
    let name: string | null = null;
    if (this.peek().kind === 'name') name = this.next().value;
    let variableDefinitions: VariableDefinition[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      variableDefinitions = this.parseVariableDefinitions();
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'operation', operation, name, variableDefinitions, selections };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    const out: VariableDefinition[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      this.skipDirectives();
      out.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): string {
    const token = this.peek();
    let base: string;
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      base = `[${this.parseType()}]`;
    } else {
      base = this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      return `${base}!`;
    }
    return base;
  }

  private parseFragment(): FragmentDefinition {
    this.expectName('fragment');
    const name = this.expectName();
    this.expectName('on');
    const typeCondition = this.expectName();
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { kind: 'fragment', name, typeCondition, selections };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      let typeCondition: string | null = null;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    return this.parseField();
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      args = this.parseArguments();
    }
    this.skipDirectives();
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new ParseError('A variable is not allowed in a constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue(isConst));
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`Unexpected value ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// the static schema table (validation + introspection)
// ---------------------------------------------------------------------------

interface FieldDef {
  /** The GraphQL type the field returns (a scalar name or an object type). */
  type: string;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INTERFACE' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime']);

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User' },
      repository: { type: 'Repository' },
      node: { type: 'Node' },
      nodes: { type: 'Node' },
      __type: { type: '__Type' },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload' },
      closeIssue: { type: 'CloseIssuePayload' },
      createPullRequest: { type: 'CreatePullRequestPayload' },
      mergePullRequest: { type: 'MergePullRequestPayload' },
      addComment: { type: 'AddCommentPayload' },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID' } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      login: { type: 'String' },
      name: { type: 'String' },
      email: { type: 'String' },
      url: { type: 'URI' },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      databaseId: { type: 'Int' },
      name: { type: 'String' },
      nameWithOwner: { type: 'String' },
      owner: { type: 'User' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean' },
      description: { type: 'String' },
      private: { type: 'Boolean' },
      url: { type: 'URI' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      issue: { type: 'Issue' },
      issues: { type: 'IssueConnection' },
      pullRequests: { type: 'PullRequestConnection' },
      pullRequest: { type: 'PullRequest' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: { name: { type: 'String' }, target: { type: 'GitObject' } },
  },
  GitObject: { kind: 'OBJECT', fields: { oid: { type: 'String' } } },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      number: { type: 'Int' },
      title: { type: 'String' },
      state: { type: 'IssueState' },
      body: { type: 'String' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      url: { type: 'URI' },
      author: { type: 'User' },
      labels: { type: 'LabelConnection' },
      comments: { type: 'IssueCommentConnection' },
    },
  },
  Label: {
    kind: 'OBJECT',
    fields: { id: { type: 'ID' }, name: { type: 'String' }, color: { type: 'String' }, description: { type: 'String' } },
  },
  LabelConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: 'Label' }, edges: { type: 'LabelEdge' }, pageInfo: { type: 'PageInfo' }, totalCount: { type: 'Int' } },
  },
  LabelEdge: { kind: 'OBJECT', fields: { node: { type: 'Label' }, cursor: { type: 'String' } } },
  IssueConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: 'Issue' }, edges: { type: 'IssueEdge' }, pageInfo: { type: 'PageInfo' }, totalCount: { type: 'Int' } },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String' } } },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: 'IssueComment' }, edges: { type: 'IssueCommentEdge' }, pageInfo: { type: 'PageInfo' }, totalCount: { type: 'Int' } },
  },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String' } } },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      body: { type: 'String' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      author: { type: 'User' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID' },
      number: { type: 'Int' },
      title: { type: 'String' },
      body: { type: 'String' },
      state: { type: 'PullRequestState' },
      merged: { type: 'Boolean' },
      mergedAt: { type: 'DateTime' },
      mergeable: { type: 'MergeableState' },
      headRefName: { type: 'String' },
      baseRefName: { type: 'String' },
      headRefOid: { type: 'String' },
      baseRefOid: { type: 'String' },
      files: { type: 'PullRequestChangedFileConnection' },
      createdAt: { type: 'DateTime' },
      updatedAt: { type: 'DateTime' },
      url: { type: 'URI' },
      author: { type: 'User' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: 'PullRequest' }, edges: { type: 'PullRequestEdge' }, pageInfo: { type: 'PageInfo' }, totalCount: { type: 'Int' } },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String' } } },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: 'PullRequestChangedFile' }, edges: { type: 'PullRequestChangedFileEdge' }, pageInfo: { type: 'PageInfo' }, totalCount: { type: 'Int' } },
  },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequestChangedFile' }, cursor: { type: 'String' } } },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String' },
      additions: { type: 'Int' },
      deletions: { type: 'Int' },
      changeType: { type: 'PullRequestChangeType' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean' },
      hasPreviousPage: { type: 'Boolean' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: { type: 'IssueCommentEdge' }, subject: { type: 'Node' }, clientMutationId: { type: 'String' } },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: { type: '__Type' },
      queryType: { type: '__Type' },
      mutationType: { type: '__Type' },
      description: { type: 'String' },
      directives: { type: '__Directive' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      kind: { type: 'String' },
      description: { type: 'String' },
      fields: { type: '__Field' },
      enumValues: { type: '__EnumValue' },
      inputFields: { type: '__InputValue' },
      interfaces: { type: '__Type' },
      possibleTypes: { type: '__Type' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      args: { type: '__InputValue' },
      type: { type: '__Type' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      type: { type: '__Type' },
      defaultValue: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean' },
      deprecationReason: { type: 'String' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: { name: { type: 'String' }, description: { type: 'String' } },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestChangeType: { kind: 'ENUM', enumValues: ['ADDED', 'MODIFIED', 'REMOVED', 'RENAMED'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  SearchType: {
    kind: 'ENUM',
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'MILESTONE'],
  },
  CreateIssueInput: { kind: 'INPUT_OBJECT' },
  CloseIssueInput: { kind: 'INPUT_OBJECT' },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT' },
  MergePullRequestInput: { kind: 'INPUT_OBJECT' },
  AddCommentInput: { kind: 'INPUT_OBJECT' },
  IssueOrder: { kind: 'INPUT_OBJECT' },
};

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

function isObjectType(typeName: string): boolean {
  const def = SCHEMA[typeName];
  return def !== undefined && (def.kind === 'OBJECT' || def.kind === 'INTERFACE');
}

/** Validate one operation's selections against the schema; returns the error messages. */
function validateSelections(
  typeName: string,
  selections: SelectionNode[],
  fragments: Map<string, FragmentDefinition>,
  errors: string[],
  depth: number,
): void {
  if (depth > 32) {
    errors.push('Selection nesting is too deep');
    return;
  }
  const typeDef = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') {
        if (selection.selections !== null) errors.push('Field "__typename" must not have a selection set');
        continue;
      }
      const field = typeDef?.fields?.[selection.name];
      if (field === undefined) {
        errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
        continue;
      }
      if (selection.selections !== null) {
        if (!isObjectType(field.type)) {
          errors.push(`Field "${selection.name}" of type "${field.type}" must not have a selection set.`);
        } else {
          validateSelections(field.type, selection.selections, fragments, errors, depth + 1);
        }
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (fragment === undefined) {
        errors.push(`Unknown fragment "${selection.name}".`);
        continue;
      }
      if (!fragmentApplies(typeName, fragment.typeCondition)) {
        errors.push(`Fragment "${selection.name}" cannot be spread here: fragment on "${fragment.typeCondition}" never applies to "${typeName}".`);
        continue;
      }
      validateSelections(fragment.typeCondition, fragment.selections, fragments, errors, depth + 1);
      continue;
    }
    // Inline fragment.
    const condition = selection.typeCondition ?? typeName;
    if (SCHEMA[condition] === undefined) {
      errors.push(`Unknown type "${condition}".`);
      continue;
    }
    if (!fragmentApplies(typeName, condition)) {
      errors.push(`Fragment cannot be spread here: fragment on "${condition}" never applies to "${typeName}".`);
      continue;
    }
    validateSelections(condition, selection.selections, fragments, errors, depth + 1);
  }
}

/** Whether a fragment on `condition` can apply to a value of `typeName`. */
function fragmentApplies(typeName: string, condition: string): boolean {
  if (typeName === condition) return true;
  if (typeName === 'Node') return true; // Node's possible types are Repository, Issue, PullRequest.
  if (condition === 'Node') return typeName === 'Repository' || typeName === 'Issue' || typeName === 'PullRequest';
  return false;
}

// ---------------------------------------------------------------------------
// values and variables
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function valueFromNode(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromNode(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

function argumentsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueFromNode(arg.value, variables);
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' ? value : undefined;
}

function intArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// cursors and connections
// ---------------------------------------------------------------------------

/** A stable, opaque cursor for one issue number. */
function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1], 10);
  } catch {
    return null;
  }
}

interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

/** Slice `nodes` after `after` and cap at `first`, with its pageInfo. */
function pageConnection<T extends { number: number }>(
  nodes: readonly T[],
  first: number | undefined,
  after: string | undefined,
): { nodes: T[]; pageInfo: PageInfo; totalCount: number } {
  let start = 0;
  if (after !== undefined && after !== null) {
    const afterNumber = cursorNumber(after);
    if (afterNumber !== null) {
      const index = nodes.findIndex((node) => node.number === afterNumber);
      if (index !== -1) start = index + 1;
    }
  }
  const rest = nodes.slice(start);
  const page = first === undefined ? rest : rest.slice(0, first);
  const hasNextPage = first !== undefined ? rest.length > first : false;
  return {
    nodes: page,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length === 0 ? null : issueCursor(page[0]!.number),
      endCursor: page.length === 0 ? null : issueCursor(page[page.length - 1]!.number),
    },
    totalCount: nodes.length,
  };
}

/** One connection object: its nodes, pageInfo and total count. */
function connectionObject(typename: string, nodes: GqlObject[], pageInfo: PageInfo, totalCount: number): GqlObject {
  return { __typename: typename, _nodes: nodes, _pageInfo: pageInfo, totalCount };
}

/** A connection holding one full page: no cursor, no next page. */
function wholeConnection(typename: string, nodes: GqlObject[]): GqlObject {
  return connectionObject(
    typename,
    nodes,
    { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    nodes.length,
  );
}

// ---------------------------------------------------------------------------
// object builders (the values resolvers hand back)
// ---------------------------------------------------------------------------

type GqlObject = Record<string, unknown> & { __typename: string };

function userObject(store: Store, login: string): GqlObject | null {
  const user = store.getUser(login);
  if (user === undefined) return null;
  return {
    __typename: 'User',
    id: `U_${user.login}`,
    login: user.login,
    name: user.name,
    email: user.email,
    url: `https://github.com/${user.login}`,
  };
}

function repositoryObject(store: Store, repo: Repo): GqlObject {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: store.repoId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    url: `https://github.com/${repo.fullName}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: issue.id,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullObject(store: Store, repo: Repo, pull: Pull): GqlObject {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    headRefOid: pull.head.sha,
    baseRefOid: pull.base.sha,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

function commentObject(repo: Repo, issueNumber: number, id: number, body: string, createdAt: string): GqlObject {
  return {
    __typename: 'IssueComment',
    id: `IC_${repo.owner}_${repo.name}_${issueNumber}_${id}`,
    body,
    createdAt,
    updatedAt: createdAt,
  };
}

function typeObject(name: string): GqlObject | null {
  const def = SCHEMA[name];
  if (def === undefined) return null;
  return {
    __typename: '__Type',
    _typeName: name,
    name,
    kind: def.kind,
    description: null,
  };
}

function fieldObject(typeName: string, fieldName: string): GqlObject {
  return {
    __typename: '__Field',
    _typeName: typeName,
    _fieldName: fieldName,
    name: fieldName,
    description: null,
  };
}

function enumValueObject(name: string): GqlObject {
  return { __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null };
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

class GraphQLError extends Error {
  readonly path: Array<string | number> | undefined;

  constructor(message: string, path?: Array<string | number>) {
    super(message);
    this.name = 'GraphQLError';
    this.path = path;
  }
}

/**
 * Execute one operation document. Returns the `{data, errors?}` envelope
 * (errors omitted when empty).
 */
function executeDocument(
  store: Store,
  query: string,
  variables: Variables,
  operationName: string | undefined,
): Record<string, unknown> {
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, errors: [{ message: `Syntax Error: ${message}` }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'The document holds no operation.' }] };
  }
  let operation: OperationDefinition | undefined;
  if (operationName !== undefined) {
    operation = document.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (document.operations.length === 1) {
    operation = document.operations[0]!;
  } else {
    return {
      data: null,
      errors: [{ message: 'Must provide operation name when there are multiple operations.' }],
    };
  }

  // Bind the variables, applying defaults from the definitions.
  const bound: Variables = { ...variables };
  for (const def of operation.variableDefinitions) {
    if (bound[def.name] === undefined && def.defaultValue !== null) {
      bound[def.name] = valueFromNode(def.defaultValue, {});
    }
  }

  // Validate the whole operation before executing any of it.
  const errors: string[] = [];
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelections(rootType, operation.selections, document.fragments, errors, 0);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }

  const data: Record<string, unknown> = {};
  const gqlErrors: Array<Record<string, unknown>> = [];
  for (const selection of operation.selections) {
    try {
      const value = executeSelection(rootType, null, selection, document.fragments, store, bound, []);
      if (selection.kind === 'field') {
        data[selection.alias ?? selection.name] = value;
      } else if (isRecord(value)) {
        Object.assign(data, value);
      }
    } catch (err) {
      if (err instanceof GraphQLError) {
        gqlErrors.push({ message: err.message, path: err.path });
        if (selection.kind === 'field') data[selection.alias ?? selection.name] = null;
      } else {
        throw err;
      }
    }
  }
  const out: Record<string, unknown> = { data };
  if (gqlErrors.length > 0) out.errors = gqlErrors;
  return out;
}

/**
 * Execute one selection against a parent value of `typeName`. A field
 * returns its (sub-selected) value; a fragment returns a partial data
 * object merged by the caller.
 */
function executeSelection(
  typeName: string,
  parent: GqlObject | null,
  selection: SelectionNode,
  fragments: Map<string, FragmentDefinition>,
  store: Store,
  variables: Variables,
  path: Array<string | number>,
): unknown {
  if (selection.kind === 'fragmentSpread') {
    const fragment = fragments.get(selection.name);
    if (fragment === undefined) return {};
    if (!fragmentApplies(typeName, fragment.typeCondition)) return {};
    return executeSelectionSet(fragment.typeCondition, parent, fragment.selections, fragments, store, variables, path);
  }
  if (selection.kind === 'inlineFragment') {
    const condition = selection.typeCondition ?? typeName;
    if (!fragmentApplies(typeName, condition)) return {};
    return executeSelectionSet(condition, parent, selection.selections, fragments, store, variables, path);
  }
  // A field.
  const key = selection.alias ?? selection.name;
  const fieldPath = [...path, key];
  const value = resolveField(typeName, parent, selection, store, variables, fieldPath);
  if (selection.selections === null || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) {
    const itemType = fieldReturnType(typeName, selection.name);
    return value.map((item, index) =>
      executeSelectionSet(itemType, item as GqlObject, selection.selections!, fragments, store, variables, [...fieldPath, index]),
    );
  }
  if (isRecord(value)) {
    const itemType = (value as GqlObject).__typename ?? fieldReturnType(typeName, selection.name);
    return executeSelectionSet(itemType, value as GqlObject, selection.selections, fragments, store, variables, fieldPath);
  }
  return value;
}

function executeSelectionSet(
  typeName: string,
  parent: GqlObject | null,
  selections: SelectionNode[],
  fragments: Map<string, FragmentDefinition>,
  store: Store,
  variables: Variables,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out[selection.alias ?? selection.name] = executeSelection(typeName, parent, selection, fragments, store, variables, path);
    } else {
      const partial = executeSelection(typeName, parent, selection, fragments, store, variables, path);
      if (isRecord(partial)) Object.assign(out, partial);
    }
  }
  return out;
}

function fieldReturnType(typeName: string, fieldName: string): string {
  return SCHEMA[typeName]?.fields?.[fieldName]?.type ?? 'String';
}

/** Resolve one field's raw value (before its sub-selections run). */
function resolveField(
  typeName: string,
  parent: GqlObject | null,
  field: FieldNode,
  store: Store,
  variables: Variables,
  path: Array<string | number>,
): unknown {
  if (field.name === '__typename') return typeName;
  const args = argumentsOf(field, variables);
  switch (typeName) {
    case 'Query':
      return resolveQueryField(parent, field, args, store, path);
    case 'Mutation':
      return resolveMutationField(field, args, store, path);
    case 'Repository':
      return resolveRepositoryField(parent, field, args, store, path);
    case 'Issue':
      return resolveIssueField(parent, field, store);
    case 'PullRequest':
      return resolvePullRequestField(parent, field, args, store);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
      return resolveConnectionField(parent, field);
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestChangedFileEdge':
    case 'LabelEdge':
    case 'IssueCommentEdge':
      return resolveEdgeField(parent, field);
    case '__Type':
      return resolveTypeField(parent, field);
    case '__Field':
      return resolveFieldField(parent, field);
    case '__Schema':
      return resolveSchemaField(field);
    default: {
      if (parent !== null && field.name in parent) return parent[field.name] ?? null;
      return null;
    }
  }
}

function resolveQueryField(
  _parent: GqlObject | null,
  field: FieldNode,
  args: Record<string, unknown>,
  store: Store,
  path: Array<string | number>,
): unknown {
  switch (field.name) {
    case 'viewer':
      return userObject(store, store.viewer().login);
    case 'repository': {
      const owner = stringArg(args, 'owner');
      const name = stringArg(args, 'name');
      if (owner === undefined || name === undefined) return null;
      const repo = store.getRepo(owner, name);
      return repo === undefined ? null : repositoryObject(store, repo);
    }
    case 'node': {
      const id = stringArg(args, 'id');
      if (id === undefined) return null;
      return nodeObject(store, id);
    }
    case '__type': {
      const name = stringArg(args, 'name');
      if (name === undefined) return null;
      return typeObject(name);
    }
    case '__schema':
      return { __typename: '__Schema', description: null };
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`, path);
  }
}

/** Resolve a Relay `node(id:)` id to its object, or null. */
function nodeObject(store: Store, id: string): GqlObject | null {
  if (id.startsWith('R_')) {
    const repo = store.findRepoById(id);
    return repo === null ? null : repositoryObject(store, repo);
  }
  if (id.startsWith('PR_')) {
    const found = store.findPullById(id);
    return found === null ? null : pullObject(store, found.repo, found.pull);
  }
  if (id.startsWith('I_')) {
    const found = store.findIssueById(id);
    return found === null ? null : issueObject(found.repo, found.issue);
  }
  return null;
}

function resolveMutationField(
  field: FieldNode,
  args: Record<string, unknown>,
  store: Store,
  path: Array<string | number>,
): unknown {
  const input = isRecord(args.input) ? args.input : {};
  switch (field.name) {
    case 'createIssue': {
      const repositoryId = stringArg(input, 'repositoryId');
      const title = stringArg(input, 'title');
      if (repositoryId === undefined || title === undefined) {
        throw new GraphQLError('createIssue needs input.repositoryId and input.title.', path);
      }
      const repo = store.findRepoById(repositoryId);
      if (repo === null) throw new GraphQLError('Repository not found.', path);
      const issue = store.createIssue(repo, { title, body: stringArg(input, 'body') });
      return { __typename: 'CreateIssuePayload', issue: issueObject(repo, issue), clientMutationId: stringArg(input, 'clientMutationId') ?? null };
    }
    case 'closeIssue': {
      const issueId = stringArg(input, 'issueId');
      if (issueId === undefined) throw new GraphQLError('closeIssue needs input.issueId.', path);
      const found = store.findIssueById(issueId);
      if (found === null) throw new GraphQLError('Issue not found.', path);
      const closed = store.setIssueState(found.repo, found.issue.number, 'closed');
      return { __typename: 'CloseIssuePayload', issue: issueObject(found.repo, closed), clientMutationId: stringArg(input, 'clientMutationId') ?? null };
    }
    case 'createPullRequest': {
      const repositoryId = stringArg(input, 'repositoryId');
      const headRefName = stringArg(input, 'headRefName');
      const baseRefName = stringArg(input, 'baseRefName');
      const title = stringArg(input, 'title');
      if (repositoryId === undefined || headRefName === undefined || baseRefName === undefined || title === undefined) {
        throw new GraphQLError('createPullRequest needs input.repositoryId, headRefName, baseRefName and title.', path);
      }
      const repo = store.findRepoById(repositoryId);
      if (repo === null) throw new GraphQLError('Repository not found.', path);
      try {
        const pull = store.createPull(repo, { title, body: stringArg(input, 'body'), head: headRefName, base: baseRefName });
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(store, repo, pull), clientMutationId: stringArg(input, 'clientMutationId') ?? null };
      } catch (err) {
        if (isStoreError(err)) throw new GraphQLError(err.message, path);
        throw err;
      }
    }
    case 'mergePullRequest': {
      const pullRequestId = stringArg(input, 'pullRequestId');
      if (pullRequestId === undefined) throw new GraphQLError('mergePullRequest needs input.pullRequestId.', path);
      const found = store.findPullById(pullRequestId);
      if (found === null) throw new GraphQLError('Pull request not found.', path);
      try {
        store.mergePullSquash(found.repo, found.pull.number);
      } catch (err) {
        if (isStoreError(err)) throw new GraphQLError(err.message, path);
        throw err;
      }
      const merged = store.getPull(found.repo, found.pull.number)!;
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(store, found.repo, merged), clientMutationId: stringArg(input, 'clientMutationId') ?? null };
    }
    case 'addComment': {
      const subjectId = stringArg(input, 'subjectId');
      const body = stringArg(input, 'body');
      if (subjectId === undefined || body === undefined) {
        throw new GraphQLError('addComment needs input.subjectId and input.body.', path);
      }
      const found = store.findIssueById(subjectId);
      if (found === null) throw new GraphQLError('Issue not found.', path);
      const comment = store.addComment(found.repo, found.issue.number, body);
      const node = commentObject(found.repo, found.issue.number, comment.id, comment.body, comment.createdAt);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: null },
        subject: issueObject(found.repo, found.issue),
        clientMutationId: stringArg(input, 'clientMutationId') ?? null,
      };
    }
    default:
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`, path);
  }
}

function resolveRepositoryField(
  parent: GqlObject | null,
  field: FieldNode,
  args: Record<string, unknown>,
  store: Store,
  path: Array<string | number>,
): unknown {
  const repo = (parent?._repo ?? null) as Repo | null;
  if (repo === null) return null;
  switch (field.name) {
    case 'owner':
      return userObject(store, repo.owner);
    case 'defaultBranchRef': {
      const tip = store.branchTip(repo, repo.defaultBranch);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'GitObject', oid: tip } };
    }
    case 'issue': {
      const number = intArg(args, 'number');
      if (number === undefined) return null;
      const issue = store.getIssue(repo, number);
      return issue === undefined ? null : issueObject(repo, issue);
    }
    case 'issues':
      return issuesConnection(store, repo, args);
    case 'pullRequests':
      return pullsConnection(store, repo, args);
    case 'pullRequest': {
      const number = intArg(args, 'number');
      if (number === undefined) return null;
      const pull = store.getPull(repo, number);
      return pull === undefined ? null : pullObject(store, repo, store.refreshPullFiles(repo, pull));
    }
    default:
      if (field.name in parent) return parent[field.name] ?? null;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Repository".`, path);
  }
}

/** The issues connection: OPEN only unless `states` says otherwise. */
function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): GqlObject {
  const statesArg = Array.isArray(args.states) ? args.states : undefined;
  const wanted: Set<string> = statesArg === undefined
    ? new Set(['OPEN'])
    : new Set(statesArg.filter((entry): entry is string => typeof entry === 'string'));
  let issues = store.listIssues(repo, 'all').filter((issue) =>
    wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'),
  );
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const orderField = stringArg(orderBy, 'field') ?? 'CREATED_AT';
  const direction = stringArg(orderBy, 'direction') ?? 'DESC';
  const sign = direction === 'ASC' ? 1 : -1;
  issues = [...issues].sort((a, b) => {
    let by = 0;
    if (orderField === 'UPDATED_AT') by = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (orderField === 'COMMENTS') by = store.listComments(repo, a.number).length - store.listComments(repo, b.number).length;
    else by = a.createdSeq - b.createdSeq;
    if (by === 0) by = a.number - b.number;
    return by * sign;
  });
  const first = intArg(args, 'first');
  const after = stringArg(args, 'after');
  const page = pageConnection(issues, first, after);
  return connectionObject(
    'IssueConnection',
    page.nodes.map((issue) => issueObject(repo, issue)),
    page.pageInfo,
    page.totalCount,
  );
}

/** The pull-requests connection: OPEN only unless `states` says otherwise. */
function pullsConnection(store: Store, repo: Repo, args: Record<string, unknown>): GqlObject {
  const statesArg = Array.isArray(args.states) ? args.states : undefined;
  const wanted: Set<string> = statesArg === undefined
    ? new Set(['OPEN'])
    : new Set(statesArg.filter((entry): entry is string => typeof entry === 'string'));
  let pulls = store.listPulls(repo, 'all').filter((pull) =>
    wanted.has(pull.state === 'open' ? 'OPEN' : 'CLOSED'),
  );
  pulls = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  const first = intArg(args, 'first');
  const after = stringArg(args, 'after');
  const page = pageConnection(pulls, first, after);
  return connectionObject(
    'PullRequestConnection',
    page.nodes.map((pull) => pullObject(store, repo, store.refreshPullFiles(repo, pull))),
    page.pageInfo,
    page.totalCount,
  );
}

function resolveIssueField(parent: GqlObject | null, field: FieldNode, store: Store): unknown {
  const repo = (parent?._repo ?? null) as Repo | null;
  const issue = (parent?._issue ?? null) as Issue | null;
  if (repo === null || issue === null) return null;
  switch (field.name) {
    case 'author':
      return userObject(store, repo.owner);
    case 'labels': {
      const nodes = issue.labels.map((label) => ({
        __typename: 'Label',
        id: `L_${repo.owner}_${repo.name}_${label.name}`,
        name: label.name,
        color: label.color,
        description: label.description,
      }));
      return wholeConnection('LabelConnection', nodes);
    }
    case 'comments': {
      const comments = store.listComments(repo, issue.number);
      const nodes = comments.map((comment) => commentObject(repo, issue.number, comment.id, comment.body, comment.createdAt));
      return wholeConnection('IssueCommentConnection', nodes);
    }
    default:
      if (field.name in parent) return parent[field.name] ?? null;
      return null;
  }
}

function resolvePullRequestField(
  parent: GqlObject | null,
  field: FieldNode,
  args: Record<string, unknown>,
  store: Store,
): unknown {
  const repo = (parent?._repo ?? null) as Repo | null;
  const pull = (parent?._pull ?? null) as Pull | null;
  if (repo === null || pull === null) return null;
  switch (field.name) {
    case 'author':
      return userObject(store, repo.owner);
    case 'mergeable':
      return store.prMergeable(repo, pull);
    case 'files': {
      const refreshed = store.refreshPullFiles(repo, pull);
      const first = intArg(args, 'first');
      const nodes = refreshed.files.map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      const page = first === undefined ? nodes : nodes.slice(0, first);
      return connectionObject(
        'PullRequestChangedFileConnection',
        page,
        {
          hasNextPage: first !== undefined && nodes.length > first,
          hasPreviousPage: false,
          startCursor: null,
          endCursor: null,
        },
        nodes.length,
      );
    }
    default:
      if (field.name in parent) return parent[field.name] ?? null;
      return null;
  }
}

function resolveConnectionField(parent: GqlObject | null, field: FieldNode): unknown {
  if (parent === null) return null;
  switch (field.name) {
    case 'nodes':
      return parent._nodes ?? [];
    case 'edges': {
      const nodes = (parent._nodes ?? []) as GqlObject[];
      return nodes.map((node) => ({ __typename: edgeTypeFor(parent.__typename), node, cursor: null }));
    }
    case 'pageInfo': {
      const info = (parent._pageInfo ?? null) as PageInfo | null;
      if (info === null) return { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      return { __typename: 'PageInfo', ...info };
    }
    case 'totalCount':
      return parent.totalCount ?? ((parent._nodes as unknown[])?.length ?? 0);
    default:
      return null;
  }
}

function edgeTypeFor(connectionType: string): string {
  switch (connectionType) {
    case 'IssueConnection': return 'IssueEdge';
    case 'PullRequestConnection': return 'PullRequestEdge';
    case 'PullRequestChangedFileConnection': return 'PullRequestChangedFileEdge';
    case 'LabelConnection': return 'LabelEdge';
    case 'IssueCommentConnection': return 'IssueCommentEdge';
    default: return 'IssueEdge';
  }
}

function resolveEdgeField(parent: GqlObject | null, field: FieldNode): unknown {
  if (parent === null) return null;
  if (field.name === 'node') return parent.node ?? null;
  if (field.name === 'cursor') return parent.cursor ?? null;
  return null;
}

function resolveTypeField(parent: GqlObject | null, field: FieldNode): unknown {
  const typeName = (parent?._typeName ?? null) as string | null;
  if (typeName === null) return null;
  const def = SCHEMA[typeName];
  if (def === undefined) return null;
  switch (field.name) {
    case 'fields': {
      if (def.fields === undefined) return null;
      return Object.keys(def.fields)
        .sort()
        .map((fieldName) => fieldObject(typeName, fieldName));
    }
    case 'enumValues': {
      if (def.enumValues === undefined) return null;
      return def.enumValues.map((name) => enumValueObject(name));
    }
    case 'inputFields':
      return null;
    case 'interfaces':
      return [];
    case 'possibleTypes':
      return [];
    default:
      if (field.name in parent) return parent[field.name] ?? null;
      return null;
  }
}

function resolveFieldField(parent: GqlObject | null, field: FieldNode): unknown {
  if (parent === null) return null;
  switch (field.name) {
    case 'args':
      return [];
    case 'type': {
      const typeName = (parent._typeName ?? null) as string | null;
      const fieldName = (parent._fieldName ?? null) as string | null;
      if (typeName === null || fieldName === null) return null;
      const returnType = SCHEMA[typeName]?.fields?.[fieldName]?.type ?? 'String';
      return typeObject(returnType);
    }
    default:
      if (field.name in parent) return parent[field.name] ?? null;
      return null;
  }
}

function resolveSchemaField(field: FieldNode): unknown {
  switch (field.name) {
    case 'queryType':
      return typeObject('Query');
    case 'mutationType':
      return typeObject('Mutation');
    case 'types':
      return Object.keys(SCHEMA)
        .sort()
        .map((name) => typeObject(name))
        .filter((entry): entry is GqlObject => entry !== null);
    case 'directives':
      return [];
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// the HTTP handler
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1 << 20;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let failed = false;
    req.on('data', (chunk: Buffer | string) => {
      if (failed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        failed = true;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err: Error) => {
      if (!failed) {
        failed = true;
        reject(err);
      }
    });
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': nextRequestId(),
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  });
  res.end(body);
}

/**
 * Answer one GraphQL request. Returns true when the path is
 * POST /api/graphql (and the request has been answered, including error
 * answers), false otherwise so the caller falls through to its own 404.
 */
export async function handleGraphql(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  if (path !== '/api/graphql') return false;
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') return false;
  try {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return true;
    }
    let text: string;
    try {
      text = await readBody(req);
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Could not read request body' }] });
      return true;
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
      return true;
    }
    if (Array.isArray(body)) {
      // GitHub-style operation batching: one result per document, in order.
      const results = body.map((entry) => {
        if (!isRecord(entry) || typeof entry.query !== 'string') {
          return { data: null, errors: [{ message: 'Each batched operation needs a query string.' }] };
        }
        const variables = isRecord(entry.variables) ? (entry.variables as Variables) : {};
        const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
        return executeDocument(store, entry.query, variables, operationName);
      });
      sendJson(res, 200, results);
      return true;
    }
    if (!isRecord(body) || typeof body.query !== 'string') {
      sendJson(res, 200, { data: null, errors: [{ message: 'The request body needs a query string.' }] });
      return true;
    }
    const variables = isRecord(body.variables) ? (body.variables as Variables) : {};
    const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
    sendJson(res, 200, executeDocument(store, body.query, variables, operationName));
  } catch {
    sendJson(res, 500, { errors: [{ message: 'Internal Server Error' }] });
  }
  return true;
}
