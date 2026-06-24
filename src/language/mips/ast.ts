import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  MipsParsedExecutable,
  MipsParsedLine,
  MipsParsedOperand,
  MipsParsedRange,
  isFloatLiteral,
  isSymbolLike,
  mipsParsedRange,
  parseCharLiteral,
  parseIntegerLiteral,
  parseMacroArgumentNodes,
  parseMipsSourceDocument
} from './syntax';
import { isMipsStringLiteralText, parseMipsMemoryOperand } from './operandAst';

export interface MipsAstDocument {
  kind: 'program';
  uri: string;
  range: Range;
  lines: MipsAstLine[];
  statements: MipsStatementAst[];
  macros: MipsMacroDefinitionAst[];
}

export type MipsAstLine =
  | MipsBlankLineAst
  | MipsCommentLineAst
  | MipsStatementAst;

export interface MipsBaseLineAst {
  kind: string;
  line: number;
  text: string;
  range: Range;
}

export interface MipsBlankLineAst extends MipsBaseLineAst {
  kind: 'blankLine';
}

export interface MipsCommentLineAst extends MipsBaseLineAst {
  kind: 'commentLine';
  comment: MipsCommentAst;
}

export interface MipsStatementAst extends MipsBaseLineAst {
  kind: 'statement';
  labels: MipsLabelAst[];
  executable?: MipsExecutableAst;
  comment?: MipsCommentAst;
}

export interface MipsLabelAst {
  kind: 'label';
  name: string;
  range: Range;
  colonRange: Range;
}

export interface MipsCommentAst {
  kind: 'comment';
  text: string;
  range: Range;
}

export type MipsExecutableAst =
  | MipsDirectiveAst
  | MipsOperationAst;

export interface MipsExecutableBaseAst {
  kind: 'directive' | 'operation';
  mnemonic: string;
  lowerMnemonic: string;
  range: Range;
  mnemonicRange: Range;
  operandText: string;
  operandRange?: Range;
  operands: MipsOperandAst[];
  macroArguments: MipsMacroArgumentAst[];
}

export interface MipsDirectiveAst extends MipsExecutableBaseAst {
  kind: 'directive';
}

export interface MipsOperationAst extends MipsExecutableBaseAst {
  kind: 'operation';
}

export type MipsOperandAst =
  | MipsRegisterOperandAst
  | MipsMacroParameterOperandAst
  | MipsIntegerOperandAst
  | MipsFloatOperandAst
  | MipsStringOperandAst
  | MipsMemoryOperandAst
  | MipsSymbolOperandAst
  | MipsExpressionOperandAst;

export interface MipsOperandBaseAst {
  kind: string;
  text: string;
  range: Range;
}

export interface MipsRegisterOperandAst extends MipsOperandBaseAst {
  kind: 'register';
}

export interface MipsMacroParameterOperandAst extends MipsOperandBaseAst {
  kind: 'macroParameter';
}

export interface MipsIntegerOperandAst extends MipsOperandBaseAst {
  kind: 'integer';
  value: number;
}

export interface MipsFloatOperandAst extends MipsOperandBaseAst {
  kind: 'float';
}

export interface MipsStringOperandAst extends MipsOperandBaseAst {
  kind: 'string';
}

export interface MipsSymbolOperandAst extends MipsOperandBaseAst {
  kind: 'symbol';
}

export interface MipsExpressionOperandAst extends MipsOperandBaseAst {
  kind: 'expression';
}

export interface MipsMemoryOperandAst extends MipsOperandBaseAst {
  kind: 'memory';
  offset: MipsOperandAst;
  base: MipsOperandAst;
}

export interface MipsMacroArgumentAst {
  kind: 'macroArgument';
  text: string;
  range: Range;
}

export interface MipsMacroDefinitionAst {
  kind: 'macroDefinition';
  name: string;
  params: MipsMacroParameterAst[];
  range: Range;
  selectionRange: Range;
  header: MipsStatementAst;
  body: MipsStatementAst[];
  end?: MipsStatementAst;
}

export interface MipsMacroParameterAst {
  kind: 'macroParameterDeclaration';
  name: string;
  range: Range;
}

export function buildMipsAst(
  document: TextDocument,
  lines: MipsParsedLine[] = parseMipsSourceDocument(document.getText()).lines
): MipsAstDocument {
  const astLines = lines.map((line) => buildLineAst(line));
  const statements = astLines.filter((line): line is MipsStatementAst => line.kind === 'statement');
  const macros = collectMacroDefinitions(document, statements);
  return {
    kind: 'program',
    uri: document.uri,
    range: documentRange(document),
    lines: astLines,
    statements,
    macros
  };
}

function buildLineAst(line: MipsParsedLine): MipsAstLine {
  const range = Range.create(line.line, 0, line.line, line.text.length);
  if (line.kind === 'blank') {
    return {
      kind: 'blankLine',
      line: line.line,
      text: line.text,
      range
    };
  }
  if (line.kind === 'comment') {
    return {
      kind: 'commentLine',
      line: line.line,
      text: line.text,
      range,
      comment: {
        kind: 'comment',
        text: line.comment?.value ?? '',
        range: line.comment ? Range.create(line.line, line.comment.start, line.line, line.comment.end) : range
      }
    };
  }
  return {
    kind: 'statement',
    line: line.line,
    text: line.text,
    range,
    labels: line.labels.map((label) => ({
      kind: 'label',
      name: label.name,
      range: mipsParsedRange(line.line, label.range),
      colonRange: mipsParsedRange(line.line, label.colonRange)
    })),
    executable: line.executable ? buildExecutableAst(line.line, line.executable) : undefined,
    comment: line.comment
      ? {
        kind: 'comment',
        text: line.comment.value,
        range: Range.create(line.line, line.comment.start, line.line, line.comment.end)
      }
      : undefined
  };
}

function buildExecutableAst(line: number, executable: MipsParsedExecutable): MipsExecutableAst {
  const base = {
    mnemonic: executable.mnemonic,
    lowerMnemonic: executable.lowerMnemonic,
    range: executable.operandRange
      ? Range.create(line, executable.range.start, line, executable.operandRange.end)
      : mipsParsedRange(line, executable.range),
    mnemonicRange: mipsParsedRange(line, executable.range),
    operandText: executable.operandText,
    operandRange: executable.operandRange ? mipsParsedRange(line, executable.operandRange) : undefined,
    operands: executable.operands.map((operand) => buildOperandAst(line, operand)),
    macroArguments: executable.operandRange
      ? parseMacroArgumentNodes(executable.operandText, executable.operandRange.start).map((argument) => ({
        kind: 'macroArgument' as const,
        text: argument.text,
        range: mipsParsedRange(line, argument.range)
      }))
      : []
  };
  return executable.kind === 'directive'
    ? { kind: 'directive', ...base }
    : { kind: 'operation', ...base };
}

function buildOperandAst(line: number, operand: MipsParsedOperand): MipsOperandAst {
  const range = mipsParsedRange(line, operand.range);
  const text = operand.text;
  const memory = parseMipsMemoryOperand(text);
  if (memory) {
    const open = matchingMemoryOpenParen(text);
    const close = text.lastIndexOf(')');
    const offsetSpan = trimmedSpan(text, 0, open);
    const baseSpan = trimmedSpan(text, open + 1, close);
    return {
      kind: 'memory',
      text,
      range,
      offset: buildSyntheticOperandAst(line, memory.offset, {
        start: operand.range.start + offsetSpan.start,
        end: operand.range.start + offsetSpan.end
      }),
      base: buildSyntheticOperandAst(line, memory.base, {
        start: operand.range.start + baseSpan.start,
        end: operand.range.start + baseSpan.end
      })
    };
  }
  return classifyOperand(text, range);
}

function buildSyntheticOperandAst(line: number, text: string, range: MipsParsedRange): MipsOperandAst {
  return classifyOperand(text, mipsParsedRange(line, range));
}

function classifyOperand(
  text: string,
  range: Range
): MipsOperandAst {
  if (text.startsWith('$')) {
    return { kind: 'register', text, range };
  }
  if (text.startsWith('%')) {
    return { kind: 'macroParameter', text, range };
  }
  const integerValue = parseIntegerOperandValue(text);
  if (integerValue !== undefined) {
    return { kind: 'integer', text, range, value: integerValue };
  }
  if (isFloatLiteral(text)) {
    return { kind: 'float', text, range };
  }
  if (isMipsStringLiteralText(text)) {
    return { kind: 'string', text, range };
  }
  if (isSymbolLike(text)) {
    return { kind: 'symbol', text, range };
  }
  return { kind: 'expression', text, range };
}

function parseIntegerOperandValue(text: string): number | undefined {
  const charValue = parseCharLiteral(text);
  return charValue === undefined ? parseIntegerLiteral(text) : charValue;
}

function collectMacroDefinitions(document: TextDocument, statements: MipsStatementAst[]): MipsMacroDefinitionAst[] {
  const macros: MipsMacroDefinitionAst[] = [];
  let active: MipsMacroDefinitionAst | undefined;
  for (const statement of statements) {
    const executable = statement.executable;
    if (!executable || executable.kind !== 'directive') {
      if (active) {
        active.body.push(statement);
      }
      continue;
    }

    if (executable.lowerMnemonic === '.macro') {
      const header = parseMacroHeader(executable);
      const macro: MipsMacroDefinitionAst = {
        kind: 'macroDefinition',
        name: header?.name ?? '',
        params: header?.params ?? [],
        range: statement.range,
        selectionRange: header?.nameRange ?? executable.mnemonicRange,
        header: statement,
        body: []
      };
      macros.push(macro);
      if (active) {
        active.body.push(statement);
      }
      active = macro;
      continue;
    }

    if (executable.lowerMnemonic === '.end_macro' && active) {
      active.end = statement;
      active.range = Range.create(active.range.start, statement.range.end);
      active = undefined;
      continue;
    }

    if (active) {
      active.body.push(statement);
    }
  }

  if (active) {
    active.range = Range.create(active.range.start, documentRange(document).end);
  }
  return macros;
}

function parseMacroHeader(executable: MipsExecutableAst): { name: string; nameRange: Range; params: MipsMacroParameterAst[] } | undefined {
  const base = executable.operandRange?.start.character ?? executable.mnemonicRange.end.character;
  const text = executable.operandText;
  let offset = skipAsciiWhitespace(text, 0);
  const nameStart = offset;
  if (!isMipsSymbolStart(text[offset] ?? '')) {
    return undefined;
  }
  offset++;
  while (offset < text.length && isMipsSymbolPart(text[offset])) {
    offset++;
  }
  const name = text.slice(nameStart, offset);
  let restStart = skipAsciiWhitespace(text, offset);
  let restEnd = trimRightIndex(text, text.length);
  if (restStart < restEnd && text[restStart] === '(' && text[restEnd - 1] === ')') {
    restStart++;
    restEnd--;
  }

  const params: MipsMacroParameterAst[] = [];
  let paramStart = restStart;
  let index = restStart;
  while (index <= restEnd) {
    const atEnd = index === restEnd;
    const char = atEnd ? '' : text[index];
    if (!atEnd && char !== ',' && !isAsciiWhitespace(char)) {
      index++;
      continue;
    }
    const rawStart = skipAsciiWhitespace(text, paramStart);
    const rawEnd = trimRightIndex(text, index);
    if (rawStart < rawEnd) {
      const raw = text.slice(rawStart, rawEnd);
      const normalized = raw.startsWith('%') || raw.startsWith('$') ? raw : `%${raw}`;
      params.push({
        kind: 'macroParameterDeclaration',
        name: normalized,
        range: Range.create(
          executable.range.start.line,
          base + rawStart,
          executable.range.start.line,
          base + rawEnd
        )
      });
    }
    paramStart = index + 1;
    index++;
  }

  return {
    name,
    nameRange: Range.create(
      executable.range.start.line,
      base + nameStart,
      executable.range.start.line,
      base + offset
    ),
    params
  };
}

function matchingMemoryOpenParen(text: string): number {
  let depth = 0;
  let candidate = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === '"' && !escaped) {
        inString = false;
        escaped = false;
      } else if (char !== '\\') {
        escaped = false;
      } else {
        escaped = !escaped;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '(') {
      if (depth === 0) {
        candidate = index;
      }
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0 && index !== text.length - 1) {
        candidate = -1;
      }
    }
  }
  return candidate;
}

function trimmedSpan(text: string, start: number, end: number): MipsParsedRange {
  let left = Math.max(0, start);
  let right = Math.max(left, end);
  while (left < right && isAsciiWhitespace(text[left])) {
    left++;
  }
  while (right > left && isAsciiWhitespace(text[right - 1])) {
    right--;
  }
  return { start: left, end: right };
}

function documentRange(document: TextDocument): Range {
  const lines = document.getText().split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return Range.create(0, 0, lastLine, lines[lastLine]?.length ?? 0);
}

function skipAsciiWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && isAsciiWhitespace(text[index])) {
    index++;
  }
  return index;
}

function trimRightIndex(text: string, end: number): number {
  let index = end;
  while (index > 0 && isAsciiWhitespace(text[index - 1])) {
    index--;
  }
  return index;
}

function isMipsSymbolStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '.' || char === '$';
}

function isMipsSymbolPart(char: string): boolean {
  return isMipsSymbolStart(char) || (char >= '0' && char <= '9');
}

function isAsciiWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
}
