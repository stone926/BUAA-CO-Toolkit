import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { assignmentTargetNamesFromTokens } from './assignmentAnalysis';
import { VerilogAlwaysBlockAst } from './blockAst';
import { evalExpressionAstConstant, widthOfExpressionAst } from './expressions';
import {
  parseVerilogExpressionTokens,
  VerilogExpressionAst
} from './exprAst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';

type FlowNode =
  | BlockNode
  | AssignmentNode
  | IfNode
  | CaseNode
  | LoopNode
  | OtherNode;

interface BlockNode {
  kind: 'block';
  statements: FlowNode[];
  range: Range;
}

interface AssignmentNode {
  kind: 'assignment';
  targets: string[];
  range: Range;
}

interface IfNode {
  kind: 'if';
  consequent: FlowNode;
  alternate?: FlowNode;
  range: Range;
}

interface CaseNode {
  kind: 'case';
  caseKind: string;
  expression?: VerilogExpressionAst;
  items: CaseItemNode[];
  range: Range;
}

interface CaseItemNode {
  labels: VerilogExpressionAst[];
  defaultItem: boolean;
  body: FlowNode;
}

interface LoopNode {
  kind: 'loop';
  body: FlowNode;
  range: Range;
}

interface OtherNode {
  kind: 'other';
  range: Range;
}

interface FlowResult {
  definite: Set<string>;
  assigned: Set<string>;
  issues: DataflowIssue[];
}

interface DataflowIssue {
  range: Range;
  message: string;
  code: string;
}

export function collectCombinationalDataflowDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  module: VerilogModule,
  block: VerilogAlwaysBlockAst,
  diagnostics: Diagnostic[]
): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-008')) {
    return;
  }

  const parser = new FlowParser(document, block.bodyTokens);
  const root = parser.parseRoot();
  const result = analyzeFlow(root, new Set(), module);
  const reported = new Set<string>();
  for (const issue of result.issues) {
    const key = `${issue.code}:${issue.range.start.line}:${issue.range.start.character}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    diagnostics.push(makeDiagnostic(issue.range, issue.message, DiagnosticSeverity.Information, issue.code));
  }
  for (const name of [...result.assigned].sort()) {
    if (result.definite.has(name)) {
      continue;
    }
    const decl = module.declarations.get(name);
    diagnostics.push(makeDiagnostic(
      decl?.selectionRange ?? block.headerRange,
      `VC-008: combinational signal '${name}' is not assigned on every control-flow path.`,
      DiagnosticSeverity.Information,
      'vc-008-comb-incomplete-assignment'
    ));
  }
}

class FlowParser {
  private cursor = 0;

  constructor(
    private readonly document: TextDocument,
    private readonly tokens: VerilogToken[]
  ) {}

  parseRoot(): FlowNode {
    const statements = this.parseSequence(new Set());
    return {
      kind: 'block',
      statements,
      range: tokensRange(this.document, this.tokens)
    };
  }

  private parseSequence(stopValues: Set<string>): FlowNode[] {
    const statements: FlowNode[] = [];
    while (this.cursor < this.tokens.length) {
      const token = this.current();
      if (!token || token.kind === 'eof') {
        break;
      }
      if (stopValues.has(token.value)) {
        break;
      }
      const before = this.cursor;
      const statement = this.parseStatement(stopValues);
      statements.push(statement);
      if (this.cursor <= before) {
        this.cursor = before + 1;
      }
    }
    return statements;
  }

  private parseStatement(stopValues: Set<string>): FlowNode {
    const token = this.current();
    if (!token || token.kind === 'eof') {
      return this.makeOther(this.cursor, this.cursor);
    }
    if (token.value === 'begin') {
      return this.parseBeginEndBlock();
    }
    if (token.value === 'if') {
      return this.parseIfStatement();
    }
    if (token.value === 'case' || token.value === 'casex' || token.value === 'casez') {
      return this.parseCaseStatement();
    }
    if (token.value === 'for' || token.value === 'while' || token.value === 'repeat') {
      return this.parseLoopStatement();
    }
    if (stopValues.has(token.value)) {
      return this.makeOther(this.cursor, this.cursor);
    }
    return this.parseSimpleStatement();
  }

  private parseBeginEndBlock(): FlowNode {
    const start = this.cursor;
    this.cursor++;
    const statements = this.parseSequence(new Set(['end']));
    const end = this.current()?.value === 'end' ? this.cursor++ : Math.max(start, this.cursor - 1);
    return {
      kind: 'block',
      statements,
      range: tokenIndexRange(this.document, this.tokens, start, end)
    };
  }

  private parseIfStatement(): FlowNode {
    const start = this.cursor;
    this.cursor++;
    this.skipParenthesizedControl();
    const consequent = this.parseStatement(new Set(['else']));
    let alternate: FlowNode | undefined;
    if (this.current()?.value === 'else') {
      this.cursor++;
      alternate = this.parseStatement(new Set());
    }
    return {
      kind: 'if',
      consequent,
      alternate,
      range: Range.create(this.document.positionAt(this.tokens[start].start), (alternate ?? consequent).range.end)
    };
  }

  private parseCaseStatement(): FlowNode {
    const start = this.cursor;
    const caseKind = this.tokens[start].value;
    this.cursor++;
    const expression = this.parseParenthesizedExpression();
    const items: CaseItemNode[] = [];
    while (this.cursor < this.tokens.length && this.current()?.value !== 'endcase') {
      const labelStart = this.cursor;
      const colon = this.findTopLevelValue(':', this.cursor);
      if (colon < 0) {
        break;
      }
      const labelTokens = this.tokens.slice(labelStart, colon).filter((token) => token.kind !== 'eof');
      this.cursor = colon + 1;
      const defaultItem = labelTokens.some((token) => token.value === 'default');
      const labels = defaultItem ? [] : splitTopLevel(labelTokens, ',')
        .map(parseVerilogExpressionTokens)
        .filter((item): item is VerilogExpressionAst => Boolean(item));
      const body = this.parseStatement(new Set(['endcase']));
      items.push({
        labels,
        defaultItem,
        body
      });
    }
    const end = this.current()?.value === 'endcase' ? this.cursor++ : Math.max(start, this.cursor - 1);
    return {
      kind: 'case',
      caseKind,
      expression,
      items,
      range: tokenIndexRange(this.document, this.tokens, start, end)
    };
  }

  private parseLoopStatement(): FlowNode {
    const start = this.cursor;
    this.cursor++;
    this.skipParenthesizedControl();
    const body = this.parseStatement(new Set());
    return {
      kind: 'loop',
      body,
      range: Range.create(this.document.positionAt(this.tokens[start].start), body.range.end)
    };
  }

  private parseSimpleStatement(): FlowNode {
    const start = this.cursor;
    const end = this.findStatementEnd(this.cursor);
    this.cursor = Math.min(this.tokens.length, end + 1);
    const tokens = this.tokens.slice(start, end + 1);
    const targets = assignmentTargetNamesFromTokens(tokens);
    return targets.length
      ? {
        kind: 'assignment',
        targets,
        range: tokenIndexRange(this.document, this.tokens, start, end)
      }
      : this.makeOther(start, end);
  }

  private parseParenthesizedExpression(): VerilogExpressionAst | undefined {
    if (this.current()?.value !== '(') {
      return undefined;
    }
    const open = this.cursor;
    const close = this.findMatchingForward(open, '(', ')');
    if (close < 0) {
      return undefined;
    }
    const expression = parseVerilogExpressionTokens(this.tokens.slice(open + 1, close));
    this.cursor = close + 1;
    return expression;
  }

  private skipParenthesizedControl(): void {
    if (this.current()?.value !== '(') {
      return;
    }
    const close = this.findMatchingForward(this.cursor, '(', ')');
    this.cursor = close >= 0 ? close + 1 : this.cursor + 1;
  }

  private findTopLevelValue(value: string, start: number): number {
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let index = start; index < this.tokens.length; index++) {
      const token = this.tokens[index];
      if (token.value === 'endcase') {
        return -1;
      }
      if (token.value === '(') {
        paren++;
      } else if (token.value === ')') {
        paren = Math.max(0, paren - 1);
      } else if (token.value === '[') {
        bracket++;
      } else if (token.value === ']') {
        bracket = Math.max(0, bracket - 1);
      } else if (token.value === '{') {
        brace++;
      } else if (token.value === '}') {
        brace = Math.max(0, brace - 1);
      } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
        return index;
      }
    }
    return -1;
  }

  private findStatementEnd(start: number): number {
    let paren = 0;
    let bracket = 0;
    let brace = 0;
    for (let index = start; index < this.tokens.length; index++) {
      const token = this.tokens[index];
      if (token.value === '(') {
        paren++;
      } else if (token.value === ')') {
        paren = Math.max(0, paren - 1);
      } else if (token.value === '[') {
        bracket++;
      } else if (token.value === ']') {
        bracket = Math.max(0, bracket - 1);
      } else if (token.value === '{') {
        brace++;
      } else if (token.value === '}') {
        brace = Math.max(0, brace - 1);
      } else if (token.value === ';' && paren === 0 && bracket === 0 && brace === 0) {
        return index;
      } else if ((token.value === 'end' || token.value === 'endcase' || token.value === 'else') && paren === 0 && bracket === 0 && brace === 0) {
        return Math.max(start, index - 1);
      }
    }
    return this.tokens.length - 1;
  }

  private findMatchingForward(openIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let index = openIndex; index < this.tokens.length; index++) {
      if (this.tokens[index].value === open) {
        depth++;
      } else if (this.tokens[index].value === close) {
        depth--;
        if (depth === 0) {
          return index;
        }
      }
    }
    return -1;
  }

  private current(): VerilogToken | undefined {
    return this.tokens[this.cursor];
  }

  private makeOther(start: number, end: number): OtherNode {
    return {
      kind: 'other',
      range: tokenIndexRange(this.document, this.tokens, start, Math.max(start, end))
    };
  }
}

function analyzeFlow(node: FlowNode, before: Set<string>, module: VerilogModule): FlowResult {
  switch (node.kind) {
    case 'block':
      return analyzeBlock(node, before, module);
    case 'assignment':
      return {
        definite: union(before, new Set(node.targets)),
        assigned: new Set(node.targets),
        issues: []
      };
    case 'if':
      return analyzeIf(node, before, module);
    case 'case':
      return analyzeCase(node, before, module);
    case 'loop': {
      const body = analyzeFlow(node.body, new Set(before), module);
      return {
        definite: new Set(before),
        assigned: body.assigned,
        issues: body.issues
      };
    }
    case 'other':
      return {
        definite: new Set(before),
        assigned: new Set(),
        issues: []
      };
  }
}

function analyzeBlock(node: BlockNode, before: Set<string>, module: VerilogModule): FlowResult {
  let definite = new Set(before);
  const assigned = new Set<string>();
  const issues: DataflowIssue[] = [];
  for (const statement of node.statements) {
    const result = analyzeFlow(statement, definite, module);
    definite = result.definite;
    addAll(assigned, result.assigned);
    issues.push(...result.issues);
  }
  return {
    definite,
    assigned,
    issues
  };
}

function analyzeIf(node: IfNode, before: Set<string>, module: VerilogModule): FlowResult {
  const consequent = analyzeFlow(node.consequent, new Set(before), module);
  const assigned = new Set(consequent.assigned);
  const issues = [...consequent.issues];
  if (!node.alternate) {
    if ([...consequent.assigned].some((name) => !before.has(name))) {
      issues.push({
        range: node.range,
        message: 'VC-008: combinational if statements should cover the false branch or assign defaults before the if.',
        code: 'vc-008-comb-branch'
      });
    }
    return {
      definite: new Set(before),
      assigned,
      issues
    };
  }

  const alternate = analyzeFlow(node.alternate, new Set(before), module);
  addAll(assigned, alternate.assigned);
  issues.push(...alternate.issues);
  return {
    definite: intersection(consequent.definite, alternate.definite),
    assigned,
    issues
  };
}

function analyzeCase(node: CaseNode, before: Set<string>, module: VerilogModule): FlowResult {
  const itemResults = node.items.map((item) => analyzeFlow(item.body, new Set(before), module));
  const assigned = new Set<string>();
  const issues: DataflowIssue[] = [];
  for (const result of itemResults) {
    addAll(assigned, result.assigned);
    issues.push(...result.issues);
  }
  if (!itemResults.length) {
    return {
      definite: new Set(before),
      assigned,
      issues
    };
  }

  const covered = caseCoversEveryValue(node, module);
  if (!covered && [...assigned].some((name) => !before.has(name))) {
    issues.push({
      range: node.range,
      message: 'VC-008: combinational case statements should include default or cover every value.',
      code: 'vc-008-case-default'
    });
  }

  const paths = covered
    ? itemResults.map((result) => result.definite)
    : [...itemResults.map((result) => result.definite), before];
  return {
    definite: intersectMany(paths),
    assigned,
    issues
  };
}

function caseCoversEveryValue(node: CaseNode, module: VerilogModule): boolean {
  if (node.items.some((item) => item.defaultItem)) {
    return true;
  }
  if (node.caseKind !== 'case' || !node.expression) {
    return false;
  }
  const width = widthOfExpressionAst(node.expression, module).width;
  if (width === undefined || width < 1 || width > 8) {
    return false;
  }
  const values = new Set<bigint>();
  for (const item of node.items) {
    for (const label of item.labels) {
      const value = evalExpressionAstConstant(label, module);
      if (value !== undefined) {
        values.add(value);
      }
    }
  }
  return values.size >= 2 ** width;
}

function tokenIndexRange(document: TextDocument, tokens: VerilogToken[], start: number, end: number): Range {
  const safeStart = Math.min(Math.max(0, start), Math.max(0, tokens.length - 1));
  const safeEnd = Math.min(Math.max(safeStart, end), Math.max(0, tokens.length - 1));
  return Range.create(document.positionAt(tokens[safeStart]?.start ?? 0), document.positionAt(tokens[safeEnd]?.end ?? tokens[safeStart]?.end ?? 0));
}

function tokensRange(document: TextDocument, tokens: VerilogToken[]): Range {
  if (!tokens.length) {
    return Range.create(0, 0, 0, 0);
  }
  return Range.create(document.positionAt(tokens[0].start), document.positionAt(tokens[tokens.length - 1].end));
}

function splitTopLevel(tokens: VerilogToken[], separator: string): VerilogToken[][] {
  const result: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (token.value === separator && paren === 0 && bracket === 0 && brace === 0) {
      result.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  result.push(tokens.slice(start));
  return result.map((part) => part.filter((token) => token.kind !== 'eof')).filter((part) => part.length > 0);
}

function union<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set(left);
  addAll(result, right);
  return result;
}

function intersection<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of left) {
    if (right.has(item)) {
      result.add(item);
    }
  }
  return result;
}

function intersectMany<T>(sets: Set<T>[]): Set<T> {
  if (!sets.length) {
    return new Set();
  }
  return sets.slice(1).reduce((acc, item) => intersection(acc, item), new Set(sets[0]));
}

function addAll<T>(target: Set<T>, source: Set<T>): void {
  for (const item of source) {
    target.add(item);
  }
}
