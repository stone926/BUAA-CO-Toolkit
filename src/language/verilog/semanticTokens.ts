import {
  Range,
  SemanticTokens,
  SemanticTokensBuilder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import { mipsSemanticTokenTypes } from '../mips/resources';
import {
  systemTasks,
  VerilogDecl,
  VerilogSemanticTokenType,
  verilogKeywords,
  verilogSemanticTokenTypes
} from './model';
import {
  moduleAtPosition,
  stripCommentsAndStrings
} from './parser';
import { getCachedVerilogParse } from './parseCache';
import { VerilogWorkspaceIndex } from './workspaceIndex';

interface SemanticTokenCandidate {
  range: Range;
  tokenType: VerilogSemanticTokenType;
  modifiers?: string[];
}

const verilogTokenTypeIndex = new Map(verilogSemanticTokenTypes.map((type, index) => [type, mipsSemanticTokenTypes.length + index] as const));
const tokenModifierIndex = new Map<string, number>([['declaration', 0]]);

export function getVerilogSemanticTokens(document: TextDocument, settings: CoSettings, index: VerilogWorkspaceIndex): SemanticTokens {
  const parsed = getCachedVerilogParse(document, settings, false);
  const tokens: SemanticTokenCandidate[] = [];
  const pushed = new Set<string>();
  const builder = new SemanticTokensBuilder();

  for (const macro of parsed.macros) {
    pushSemanticToken(tokens, pushed, macro.selectionRange, 'verilogMacro', ['declaration']);
  }
  for (const macroUse of parsed.macroUses) {
    pushSemanticToken(tokens, pushed, macroUse.range, 'verilogMacro');
  }
  for (const module of parsed.modules) {
    pushSemanticToken(tokens, pushed, module.selectionRange, 'verilogModule', ['declaration']);
    for (const param of module.parameters) {
      pushSemanticToken(tokens, pushed, param.selectionRange, 'verilogParameter', ['declaration']);
    }
    for (const port of module.ports) {
      pushSemanticToken(tokens, pushed, port.selectionRange, 'verilogPort', ['declaration']);
    }
    for (const decl of module.declarations.values()) {
      if (module.ports.some((port) => port.name === decl.name) || module.parameters.some((param) => param.name === decl.name)) {
        continue;
      }
      pushSemanticToken(tokens, pushed, decl.selectionRange, 'verilogSignal', ['declaration']);
    }
    for (const instance of module.instances) {
      pushSemanticToken(tokens, pushed, instance.moduleSelectionRange, 'verilogModule');
      pushSemanticToken(tokens, pushed, instance.selectionRange, 'verilogInstance', ['declaration']);
      const target = index.getModule(instance.moduleName);
      for (const connection of instance.portConnections) {
        if (connection.nameRange) {
          pushSemanticToken(tokens, pushed, connection.nameRange, target ? 'verilogPort' : 'verilogSignal');
        }
      }
    }
  }

  let inBlockComment = false;
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = lineAt(document, lineNumber).text;
    const strippedLine = stripCommentsForSemanticLine(text, lineNumber, inBlockComment);
    inBlockComment = strippedLine.inBlockComment;
    const code = strippedLine.code;
    for (const commentRange of strippedLine.commentRanges) {
      pushSemanticToken(tokens, pushed, commentRange, 'verilogComment');
    }
    const stringRanges = pushStringAndFormatTokens(tokens, pushed, lineNumber, code);
    const numberRegex = /\b\d+'[sS]?[bBoOdDhH][0-9a-fA-F_xXzZ?]+\b|\b\d+\b/g;
    let numberMatch: RegExpExecArray | null;
    while ((numberMatch = numberRegex.exec(code))) {
      if (isInsideRanges(numberMatch.index, stringRanges)) {
        continue;
      }
      pushSemanticToken(tokens, pushed, Range.create(lineNumber, numberMatch.index, lineNumber, numberMatch.index + numberMatch[0].length), 'verilogNumber');
    }
    const taskRegex = /\$([A-Za-z_]\w*)/g;
    let taskMatch: RegExpExecArray | null;
    while ((taskMatch = taskRegex.exec(code))) {
      if (systemTasks.has(taskMatch[1])) {
        pushSemanticToken(tokens, pushed, Range.create(lineNumber, taskMatch.index, lineNumber, taskMatch.index + taskMatch[0].length), 'verilogSystemTask');
      }
    }
    const tokenRegex = /\b[A-Za-z_]\w*\b/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(code))) {
      const token = match[0];
      const previous = match.index > 0 ? code[match.index - 1] : '';
      if (previous === '$' || previous === "'" || isInsideRanges(match.index, stringRanges)) {
        continue;
      }
      const range = Range.create(lineNumber, match.index, lineNumber, match.index + token.length);
      if (previous === '`') {
        const macroRange = Range.create(lineNumber, match.index - 1, lineNumber, match.index + token.length);
        pushSemanticToken(tokens, pushed, macroRange, 'verilogMacro');
        continue;
      }
      if (pushed.has(rangeKey(range))) {
        continue;
      }
      if (verilogKeywords.has(token)) {
        pushSemanticToken(tokens, pushed, range, 'verilogKeyword');
        continue;
      }
      const module = moduleAtPosition(parsed.modules, range.start);
      if (module?.declarations.has(token)) {
        const decl = module.declarations.get(token);
        pushSemanticToken(tokens, pushed, range, declTokenType(decl));
      } else if (index.getModule(token) ?? parsed.modules.find((item) => item.name === token)) {
        pushSemanticToken(tokens, pushed, range, 'verilogModule');
      }
    }
  }

  tokens.sort(compareSemanticTokens);
  for (const token of tokens) {
    const type = verilogTokenTypeIndex.get(token.tokenType);
    if (type === undefined) {
      continue;
    }
    builder.push(
      token.range.start.line,
      token.range.start.character,
      token.range.end.character - token.range.start.character,
      type,
      tokenModifierBitset(token.modifiers)
    );
  }
  return builder.build();
}

function stripCommentsForSemanticLine(text: string, lineNumber: number, startsInBlockComment: boolean): { code: string; commentRanges: Range[]; inBlockComment: boolean } {
  const chars = text.split('');
  const commentRanges: Range[] = [];
  let index = 0;
  let inBlockComment = startsInBlockComment;

  while (index < chars.length) {
    if (inBlockComment) {
      const start = index;
      let end = chars.length;
      while (index < chars.length - 1) {
        if (chars[index] === '*' && chars[index + 1] === '/') {
          end = index + 2;
          inBlockComment = false;
          break;
        }
        index++;
      }
      for (let item = start; item < end; item++) {
        chars[item] = ' ';
      }
      commentRanges.push(Range.create(lineNumber, start, lineNumber, end));
      index = end;
      continue;
    }

    if (chars[index] === '"' || chars[index] === "'") {
      const quote = chars[index];
      index++;
      while (index < chars.length) {
        if (chars[index] === '\\') {
          index += 2;
          continue;
        }
        if (chars[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }

    if (chars[index] === '/' && chars[index + 1] === '/') {
      const start = index;
      const end = chars.length;
      for (let item = start; item < end; item++) {
        chars[item] = ' ';
      }
      commentRanges.push(Range.create(lineNumber, start, lineNumber, end));
      index = end;
      continue;
    }

    if (chars[index] === '/' && chars[index + 1] === '*') {
      const start = index;
      index += 2;
      let end = chars.length;
      inBlockComment = true;
      while (index < chars.length - 1) {
        if (chars[index] === '*' && chars[index + 1] === '/') {
          end = index + 2;
          inBlockComment = false;
          break;
        }
        index++;
      }
      for (let item = start; item < end; item++) {
        chars[item] = ' ';
      }
      commentRanges.push(Range.create(lineNumber, start, lineNumber, end));
      index = end;
      continue;
    }

    index++;
  }

  return {
    code: chars.join(''),
    commentRanges,
    inBlockComment
  };
}

function pushStringAndFormatTokens(
  tokens: SemanticTokenCandidate[],
  pushed: Set<string>,
  lineNumber: number,
  code: string
): Range[] {
  const stringRanges: Range[] = [];
  const stringRegex = /"([^"\\]|\\.)*"/g;
  const formatRegex = /%[-+0# ]*(?:\d+|\*)?(?:\.\d+)?[bBcCdDeEfFgGhHlLmMoOpPsStTuUvVzZ%]/g;
  let stringMatch: RegExpExecArray | null;
  while ((stringMatch = stringRegex.exec(code))) {
    const stringStart = stringMatch.index;
    const stringEnd = stringStart + stringMatch[0].length;
    stringRanges.push(Range.create(lineNumber, stringStart, lineNumber, stringEnd));

    let segmentStart = stringStart;
    let formatMatch: RegExpExecArray | null;
    formatRegex.lastIndex = 0;
    while ((formatMatch = formatRegex.exec(stringMatch[0]))) {
      const formatStart = stringStart + formatMatch.index;
      const formatEnd = formatStart + formatMatch[0].length;
      if (formatStart > segmentStart) {
        pushSemanticToken(tokens, pushed, Range.create(lineNumber, segmentStart, lineNumber, formatStart), 'verilogString');
      }
      pushSemanticToken(tokens, pushed, Range.create(lineNumber, formatStart, lineNumber, formatEnd), 'verilogFormatSpecifier');
      segmentStart = formatEnd;
    }
    if (segmentStart < stringEnd) {
      pushSemanticToken(tokens, pushed, Range.create(lineNumber, segmentStart, lineNumber, stringEnd), 'verilogString');
    }
  }
  return stringRanges;
}

function isInsideRanges(index: number, ranges: Range[]): boolean {
  return ranges.some((range) => index >= range.start.character && index < range.end.character);
}

function pushSemanticToken(
  tokens: SemanticTokenCandidate[],
  pushed: Set<string>,
  range: Range,
  tokenType: VerilogSemanticTokenType,
  modifiers?: string[]
): void {
  if (range.start.line !== range.end.line || range.start.character === range.end.character) {
    return;
  }
  const key = rangeKey(range);
  if (pushed.has(key)) {
    return;
  }
  pushed.add(key);
  tokens.push({
    range,
    tokenType,
    modifiers
  });
}

function compareSemanticTokens(left: SemanticTokenCandidate, right: SemanticTokenCandidate): number {
  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }
  if (left.range.start.character !== right.range.start.character) {
    return left.range.start.character - right.range.start.character;
  }
  return left.range.end.character - right.range.end.character;
}

function tokenModifierBitset(modifiers?: string[]): number {
  if (!modifiers?.length) {
    return 0;
  }
  let bitset = 0;
  for (const modifier of modifiers) {
    const index = tokenModifierIndex.get(modifier);
    if (index !== undefined) {
      bitset |= 1 << index;
    }
  }
  return bitset;
}

function declTokenType(decl: VerilogDecl | undefined): VerilogSemanticTokenType {
  if (!decl) {
    return 'verilogSignal';
  }
  if (decl.kind === 'parameter' || decl.kind === 'localparam') {
    return 'verilogParameter';
  }
  if (decl.direction) {
    return 'verilogPort';
  }
  return 'verilogSignal';
}
