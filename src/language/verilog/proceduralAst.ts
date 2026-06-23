import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseAssignmentTokens } from './assignmentAnalysis';
import { parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
import { VerilogToken } from './lexer';
import { findMatchingTokenForward, splitTopLevelTokens, trimEofTokens } from './tokenUtils';

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
  condition?: VerilogExpressionAst;
  body: VerilogProceduralStatementAst;
}

export interface VerilogDeclarationStatementAst extends VerilogProceduralStatementBase {
  kind: 'declaration';
}

export interface VerilogOtherProceduralStatementAst extends VerilogProceduralStatementBase {
  kind: 'other';
}

const declarationKeywords = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'real',
  'realtime',
  'time',
  'parameter',
  'localparam',
  'genvar'
]);

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
    const body = this.parseStatement(new Set());
    const end = Math.max(start, this.indexAtOrBeforePosition(body.range.end));
    return {
      kind: 'loop',
      loopKind,
      controlTokens,
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
    if (first && declarationKeywords.has(first.value)) {
      return {
        kind: 'declaration',
        range: tokenIndexRange(this.document, this.tokens, start, end),
        tokens
      };
    }

    const assignment = parseAssignmentTokens(tokens);
    if (assignment) {
      return {
        kind: 'assignment',
        operator: assignment.operator,
        targets: assignment.targets.map((target) => target.name),
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
    return {
      kind: 'other',
      range: tokenIndexRange(this.document, this.tokens, start, Math.max(start, end)),
      tokens: this.tokens.slice(start, Math.max(start, end) + 1)
    };
  }
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
