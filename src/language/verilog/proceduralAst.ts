import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseAssignmentTokens } from './assignmentAnalysis';
import { parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
import { VerilogToken } from './lexer';
import type { VerilogDecl } from './model';
import {
  normalizeVerilogDeclKind,
  skipVerilogStrengthGroup,
  verilogDeclarationKeywords,
  verilogDeclarationModifiers,
  verilogPortDeclarationTypes
} from './declarations';
import { findMatchingTokenForward, splitTopLevelTokens, trimEofTokens, trimTrailingSemicolonTokens } from './tokenUtils';

export type VerilogProceduralStatementAst =
  | VerilogBlockStatementAst
  | VerilogAssignmentStatementAst
  | VerilogIfStatementAst
  | VerilogCaseStatementAst
  | VerilogLoopStatementAst
  | VerilogDeclarationStatementAst
  | VerilogOtherProceduralStatementAst;

export interface VerilogProceduralStatementBase {
  kind: string;
  range: Range;
  tokens: VerilogToken[];
}

export interface VerilogBlockStatementAst extends VerilogProceduralStatementBase {
  kind: 'block';
  label?: string;
  statements: VerilogProceduralStatementAst[];
}

export interface VerilogAssignmentStatementAst extends VerilogProceduralStatementBase {
  kind: 'assignment';
  operator: '=' | '<=';
  targets: string[];
  hasDelayControl: boolean;
  hasEventControl: boolean;
  hasWaitControl: boolean;
  lhs?: VerilogExpressionAst;
  rhs?: VerilogExpressionAst;
}

export interface VerilogIfStatementAst extends VerilogProceduralStatementBase {
  kind: 'if';
  condition?: VerilogExpressionAst;
  consequent: VerilogProceduralStatementAst;
  alternate?: VerilogProceduralStatementAst;
}

export interface VerilogCaseStatementAst extends VerilogProceduralStatementBase {
  kind: 'case';
  caseKind: 'case' | 'casex' | 'casez';
  expression?: VerilogExpressionAst;
  items: VerilogCaseItemAst[];
}

export interface VerilogCaseItemAst {
  labels: VerilogExpressionAst[];
  defaultItem: boolean;
  body: VerilogProceduralStatementAst;
  range: Range;
  labelRange: Range;
}

export interface VerilogLoopStatementAst extends VerilogProceduralStatementBase {
  kind: 'loop';
  loopKind: 'for' | 'while' | 'repeat' | 'forever';
  controlTokens: VerilogToken[];
  initDeclarations: VerilogLocalDeclarationAst[];
  controlExpressions: VerilogExpressionAst[];
  condition?: VerilogExpressionAst;
  body: VerilogProceduralStatementAst;
}

export interface VerilogDeclarationStatementAst extends VerilogProceduralStatementBase {
  kind: 'declaration';
  declarations: VerilogLocalDeclarationAst[];
}

export interface VerilogLocalDeclarationAst {
  kind: 'localDeclaration';
  declaration: VerilogDecl;
  tokens: VerilogToken[];
  widthExpressions: VerilogExpressionAst[];
  initializer?: VerilogExpressionAst;
}

export interface VerilogOtherProceduralStatementAst extends VerilogProceduralStatementBase {
  kind: 'other';
  hasDelayControl: boolean;
  hasEventControl: boolean;
  hasWaitControl: boolean;
  expression?: VerilogExpressionAst;
}

export function parseVerilogProceduralBlockBody(
  document: TextDocument,
  tokens: VerilogToken[]
): VerilogBlockStatementAst {
  return new ProceduralStatementParser(document, trimEofTokens(tokens)).parseRoot();
}

class ProceduralStatementParser {
  private cursor = 0;

  constructor(
    private readonly document: TextDocument,
    private readonly tokens: VerilogToken[]
  ) {}

  parseRoot(): VerilogBlockStatementAst {
    if (!this.tokens.length) {
      return {
        kind: 'block',
        range: Range.create(0, 0, 0, 0),
        tokens: [],
        statements: []
      };
    }

    if (this.tokens[0]?.value === 'begin') {
      const saved = this.cursor;
      const block = this.parseBeginEndBlock();
      if (this.cursor >= this.tokens.length) {
        return block;
      }
      this.cursor = saved;
    }

    return {
      kind: 'block',
      range: tokensRange(this.document, this.tokens),
      tokens: this.tokens,
      statements: this.parseSequence(new Set())
    };
  }

  private parseSequence(stopValues: Set<string>): VerilogProceduralStatementAst[] {
    const statements: VerilogProceduralStatementAst[] = [];
    while (this.cursor < this.tokens.length) {
      const token = this.current();
      if (!token || token.kind === 'eof' || stopValues.has(token.value)) {
        break;
      }
      const before = this.cursor;
      statements.push(this.parseStatement(stopValues));
      if (this.cursor <= before) {
        this.cursor = before + 1;
      }
    }
    return statements;
  }

  private parseStatement(stopValues: Set<string>): VerilogProceduralStatementAst {
    const token = this.current();
    if (!token || token.kind === 'eof') {
      return this.makeOther(this.cursor, this.cursor);
    }
    if (stopValues.has(token.value)) {
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
    if (token.value === 'for' || token.value === 'while' || token.value === 'repeat' || token.value === 'forever') {
      return this.parseLoopStatement();
    }
    return this.parseSimpleStatement();
  }

  private parseBeginEndBlock(): VerilogBlockStatementAst {
    const start = this.cursor;
    this.cursor++;
    const label = this.consumeOptionalBlockLabel();
    const statements = this.parseSequence(new Set(['end']));
    const end = this.current()?.value === 'end' ? this.cursor++ : Math.max(start, this.cursor - 1);
    const tokens = this.tokens.slice(start, end + 1);
    return {
      kind: 'block',
      label,
      statements,
      range: tokenIndexRange(this.document, this.tokens, start, end),
      tokens
    };
  }

  private parseIfStatement(): VerilogIfStatementAst {
    const start = this.cursor;
    this.cursor++;
    const condition = this.parseParenthesizedExpression();
    const consequent = this.parseStatement(new Set(['else']));
    let alternate: VerilogProceduralStatementAst | undefined;
    if (this.current()?.value === 'else') {
      this.cursor++;
      alternate = this.parseStatement(new Set());
    }
    const end = Math.max(start, this.indexAtOrBeforePosition((alternate ?? consequent).range.end));
    return {
      kind: 'if',
      condition,
      consequent,
      alternate,
      range: Range.create(this.document.positionAt(this.tokens[start].start), (alternate ?? consequent).range.end),
      tokens: this.tokens.slice(start, end + 1)
    };
  }

  private parseCaseStatement(): VerilogCaseStatementAst {
    const start = this.cursor;
    const caseKind = this.tokens[start].value as 'case' | 'casex' | 'casez';
    this.cursor++;
    const expression = this.parseParenthesizedExpression();
    const items: VerilogCaseItemAst[] = [];

    while (this.cursor < this.tokens.length && this.current()?.value !== 'endcase') {
      const labelStart = this.cursor;
      const colon = this.findTopLevelValue(':', this.cursor);
      if (colon < 0) {
        break;
      }
      const labelTokens = this.tokens.slice(labelStart, colon).filter((token) => token.kind !== 'eof');
      this.cursor = colon + 1;
      const defaultItem = labelTokens.some((token) => token.value === 'default');
      const labels = defaultItem
        ? []
        : splitTopLevelTokens(labelTokens, ',')
          .map(parseVerilogExpressionTokens)
          .filter((item): item is VerilogExpressionAst => Boolean(item));
      const body = this.parseStatement(new Set(['endcase']));
      items.push({
        labels,
        defaultItem,
        body,
        range: Range.create(
          this.document.positionAt(this.tokens[labelStart]?.start ?? this.tokens[start].start),
          body.range.end
        ),
        labelRange: tokensRange(this.document, labelTokens)
      });
    }

    const end = this.current()?.value === 'endcase' ? this.cursor++ : Math.max(start, this.cursor - 1);
    return {
      kind: 'case',
      caseKind,
      expression,
      items,
      range: tokenIndexRange(this.document, this.tokens, start, end),
      tokens: this.tokens.slice(start, end + 1)
    };
  }

  private parseLoopStatement(): VerilogLoopStatementAst {
    const start = this.cursor;
    const loopKind = this.tokens[start].value as 'for' | 'while' | 'repeat' | 'forever';
    this.cursor++;
    const controlTokens = loopKind === 'forever' ? [] : this.consumeParenthesizedTokens();
    const condition = loopKind === 'while' || loopKind === 'repeat'
      ? parseVerilogExpressionTokens(controlTokens)
      : undefined;
    const initDeclarations = loopKind === 'for' ? forControlDeclarations(this.document, controlTokens) : [];
    const controlExpressions = loopKind === 'for'
      ? forControlExpressions(controlTokens)
      : condition ? [condition] : [];
    const body = this.parseStatement(new Set());
    const end = Math.max(start, this.indexAtOrBeforePosition(body.range.end));
    return {
      kind: 'loop',
      loopKind,
      controlTokens,
      initDeclarations,
      controlExpressions,
      condition,
      body,
      range: Range.create(this.document.positionAt(this.tokens[start].start), body.range.end),
      tokens: this.tokens.slice(start, end + 1)
    };
  }

  private parseSimpleStatement(): VerilogProceduralStatementAst {
    const start = this.cursor;
    const end = this.findStatementEnd(this.cursor);
    this.cursor = Math.min(this.tokens.length, end + 1);
    const tokens = this.tokens.slice(start, end + 1);
    const first = tokens[0];
    if (first && verilogDeclarationKeywords.has(first.value)) {
      return {
        kind: 'declaration',
        range: tokenIndexRange(this.document, this.tokens, start, end),
        tokens,
        declarations: localDeclarationsFromTokens(this.document, tokens)
      };
    }

    const assignment = parseAssignmentTokens(tokens);
    if (assignment) {
      const controls = proceduralControlFlags(tokens.slice(0, Math.max(assignment.lhsStart, assignment.operatorIndex)));
      return {
        kind: 'assignment',
        operator: assignment.operator,
        targets: assignment.targets.map((target) => target.name),
        ...controls,
        lhs: parseVerilogExpressionTokens(assignment.lhsTokens),
        rhs: parseVerilogExpressionTokens(assignment.rhsTokens),
        range: tokenIndexRange(this.document, this.tokens, start, end),
        tokens
      };
    }

    return this.makeOther(start, end);
  }

  private parseParenthesizedExpression(): VerilogExpressionAst | undefined {
    return parseVerilogExpressionTokens(this.consumeParenthesizedTokens());
  }

  private consumeParenthesizedTokens(): VerilogToken[] {
    if (this.current()?.value !== '(') {
      return [];
    }
    const open = this.cursor;
    const close = findMatchingTokenForward(this.tokens, open, '(', ')');
    if (close < 0) {
      this.cursor++;
      return [];
    }
    const tokens = this.tokens.slice(open + 1, close);
    this.cursor = close + 1;
    return tokens;
  }

  private consumeOptionalBlockLabel(): string | undefined {
    if (this.current()?.value !== ':') {
      return undefined;
    }
    const label = this.tokens[this.cursor + 1];
    if (!label || label.kind !== 'identifier') {
      return undefined;
    }
    this.cursor += 2;
    return label.value;
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

  private indexAtOrBeforePosition(position: { line: number; character: number }): number {
    const offset = this.document.offsetAt(position);
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      if (this.tokens[index].start <= offset) {
        return index;
      }
    }
    return 0;
  }

  private current(): VerilogToken | undefined {
    return this.tokens[this.cursor];
  }

  private makeOther(start: number, end: number): VerilogOtherProceduralStatementAst {
    const tokens = this.tokens.slice(start, Math.max(start, end) + 1);
    return {
      kind: 'other',
      range: tokenIndexRange(this.document, this.tokens, start, Math.max(start, end)),
      tokens,
      ...proceduralControlFlags(tokens),
      expression: parseVerilogExpressionTokens(trimTrailingSemicolonTokens(tokens))
    };
  }
}

function proceduralControlFlags(tokens: VerilogToken[]): { hasDelayControl: boolean; hasEventControl: boolean; hasWaitControl: boolean } {
  return {
    hasDelayControl: tokens.some((token) => token.value === '#'),
    hasEventControl: tokens.some((token) => token.value === '@'),
    hasWaitControl: tokens.some((token) => token.value === 'wait')
  };
}

function forControlDeclarations(document: TextDocument, tokens: VerilogToken[]): VerilogLocalDeclarationAst[] {
  const semicolon = tokens.findIndex((token) => token.value === ';');
  const initTokens = semicolon >= 0 ? tokens.slice(0, semicolon) : tokens;
  return localDeclarationsFromTokens(document, initTokens);
}

function forControlExpressions(tokens: VerilogToken[]): VerilogExpressionAst[] {
  const [init = [], condition = [], step = []] = splitForControlSegments(tokens);
  return [
    ...forInitControlExpressions(init),
    parseVerilogExpressionTokens(condition),
    ...assignmentOrExpressionAsts(step)
  ].filter((item): item is VerilogExpressionAst => Boolean(item));
}

function splitForControlSegments(tokens: VerilogToken[]): VerilogToken[][] {
  const segments: VerilogToken[][] = [];
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
    } else if (token.value === ';' && paren === 0 && bracket === 0 && brace === 0) {
      segments.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(tokens.slice(start));
  return segments;
}

function forInitControlExpressions(tokens: VerilogToken[]): VerilogExpressionAst[] {
  if (!tokens.length) {
    return [];
  }
  if (!verilogDeclarationKeywords.has(tokens[0].value)) {
    return assignmentOrExpressionAsts(tokens);
  }
  return splitTopLevelTokens(tokens.slice(1), ',')
    .map((part) => {
      const equal = topLevelTokenIndex(part, '=');
      return equal >= 0 ? parseVerilogExpressionTokens(part.slice(equal + 1)) : undefined;
    })
    .filter((item): item is VerilogExpressionAst => Boolean(item));
}

function assignmentOrExpressionAsts(tokens: VerilogToken[]): VerilogExpressionAst[] {
  if (!tokens.length) {
    return [];
  }
  const assignment = parseAssignmentTokens(tokens);
  if (assignment) {
    return [
      parseVerilogExpressionTokens(assignment.lhsTokens),
      parseVerilogExpressionTokens(assignment.rhsTokens)
    ].filter((item): item is VerilogExpressionAst => Boolean(item));
  }
  const expression = parseVerilogExpressionTokens(tokens);
  return expression ? [expression] : [];
}

function topLevelTokenIndex(tokens: VerilogToken[], value: string): number {
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
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}

function localDeclarationsFromTokens(document: TextDocument, tokens: VerilogToken[]): VerilogLocalDeclarationAst[] {
  const first = tokens[0];
  if (!first || !verilogDeclarationKeywords.has(first.value)) {
    return [];
  }
  const kind = normalizeVerilogDeclKind(first.value);
  const declarationTokens = trimTrailingSemicolonTokens(tokens);
  const declarations: VerilogLocalDeclarationAst[] = [];
  for (const part of splitTopLevelTokens(declarationTokens.slice(1), ',')) {
    const name = declarationNameToken(part);
    if (!name) {
      continue;
    }
    const equal = topLevelTokenIndex(part, '=');
    const initializer = equal >= 0 ? parseVerilogExpressionTokens(part.slice(equal + 1)) : undefined;
    declarations.push({
      kind: 'localDeclaration',
      declaration: {
        name: name.value,
        kind,
        range: tokensRange(document, tokens),
        selectionRange: Range.create(document.positionAt(name.start), document.positionAt(name.end))
      },
      tokens: part,
      widthExpressions: declarationWidthExpressions(part, equal >= 0 ? equal : part.length),
      initializer
    });
  }
  return declarations;
}

function declarationNameToken(tokens: VerilogToken[]): VerilogToken | undefined {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingTokenForward(tokens, index, '[', ']');
      if (close >= 0) {
        index = close;
        continue;
      }
    }
    const afterStrength = skipVerilogStrengthGroup(tokens, index);
    if (afterStrength !== index) {
      index = afterStrength - 1;
      continue;
    }
    if (
      verilogDeclarationKeywords.has(token.value) ||
      verilogDeclarationModifiers.has(token.value) ||
      verilogPortDeclarationTypes.has(token.value)
    ) {
      continue;
    }
    if (token.kind === 'identifier') {
      return token;
    }
  }
  return undefined;
}

function declarationWidthExpressions(tokens: VerilogToken[], end: number): VerilogExpressionAst[] {
  const expressions: VerilogExpressionAst[] = [];
  for (let index = 0; index < end; index++) {
    if (tokens[index].value !== '[') {
      continue;
    }
    const close = findMatchingTokenForward(tokens, index, '[', ']');
    if (close < 0 || close > end) {
      continue;
    }
    for (const part of splitTopLevelTokens(tokens.slice(index + 1, close), ':')) {
      const expression = parseVerilogExpressionTokens(part);
      if (expression) {
        expressions.push(expression);
      }
    }
    index = close;
  }
  return expressions;
}

function tokenIndexRange(document: TextDocument, tokens: VerilogToken[], start: number, end: number): Range {
  if (!tokens.length) {
    return Range.create(0, 0, 0, 0);
  }
  const safeStart = Math.min(Math.max(0, start), Math.max(0, tokens.length - 1));
  const safeEnd = Math.min(Math.max(safeStart, end), Math.max(0, tokens.length - 1));
  return Range.create(document.positionAt(tokens[safeStart].start), document.positionAt(tokens[safeEnd].end));
}

function tokensRange(document: TextDocument, tokens: VerilogToken[]): Range {
  if (!tokens.length) {
    return Range.create(0, 0, 0, 0);
  }
  return Range.create(document.positionAt(tokens[0].start), document.positionAt(tokens[tokens.length - 1].end));
}
