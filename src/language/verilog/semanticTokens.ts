import {
  Range,
  SemanticTokens,
  SemanticTokensBuilder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
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
  moduleAtPosition
} from './parser';
import { getCachedVerilogParse } from './parseCache';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { verilogTokenRange } from './cst';

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

  for (const tokenNode of parsed.cst.tokens) {
    if (tokenNode.kind === 'eof') {
      continue;
    }
    const range = verilogTokenRange(document, tokenNode);
    const token = tokenNode.value;
    if (tokenNode.kind === 'comment') {
      pushTokenText(tokens, pushed, range, token, 'verilogComment');
      continue;
    }
    if (tokenNode.kind === 'string') {
      pushStringTokenParts(tokens, pushed, range, token);
      continue;
    }
    if (tokenNode.kind === 'number') {
      pushSemanticToken(tokens, pushed, range, 'verilogNumber');
      continue;
    }
    if (tokenNode.kind === 'systemIdentifier') {
      const name = token.startsWith('$') ? token.slice(1) : token;
      if (systemTasks.has(name)) {
        pushSemanticToken(tokens, pushed, range, 'verilogSystemTask');
      }
      continue;
    }
    if (tokenNode.kind === 'directive') {
      pushSemanticToken(tokens, pushed, range, 'verilogMacro');
      continue;
    }
    if (tokenNode.kind === 'keyword') {
      pushSemanticToken(tokens, pushed, range, 'verilogKeyword');
      continue;
    }
    if (tokenNode.kind === 'punctuation' || tokenNode.kind === 'operator') {
      pushSemanticToken(tokens, pushed, range, 'verilogPunctuation');
      continue;
    }
    if (tokenNode.kind !== 'identifier') {
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

function pushTokenText(
  tokens: SemanticTokenCandidate[],
  pushed: Set<string>,
  range: Range,
  text: string,
  tokenType: VerilogSemanticTokenType
): void {
  let line = range.start.line;
  let character = range.start.character;
  let segmentStart = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && text[index] !== '\n') {
      continue;
    }
    const rawSegment = text.slice(segmentStart, index);
    const segment = rawSegment.endsWith('\r') ? rawSegment.slice(0, -1) : rawSegment;
    if (segment.length > 0) {
      pushSemanticToken(tokens, pushed, Range.create(line, character, line, character + segment.length), tokenType);
    }
    line++;
    character = 0;
    segmentStart = index + 1;
  }
}

function pushStringTokenParts(
  tokens: SemanticTokenCandidate[],
  pushed: Set<string>,
  range: Range,
  text: string
): void {
  let segmentStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '%') {
      index++;
      continue;
    }
    const formatEnd = readFormatSpecifierEnd(text, index);
    if (formatEnd === undefined) {
      index++;
      continue;
    }
    if (index > segmentStart) {
      pushSemanticToken(tokens, pushed, offsetRange(range, segmentStart, index), 'verilogString');
    }
    pushSemanticToken(tokens, pushed, offsetRange(range, index, formatEnd), 'verilogFormatSpecifier');
    index = formatEnd;
    segmentStart = formatEnd;
  }
  if (segmentStart < text.length) {
    pushSemanticToken(tokens, pushed, offsetRange(range, segmentStart, text.length), 'verilogString');
  }
}

function readFormatSpecifierEnd(text: string, start: number): number | undefined {
  let index = start + 1;
  if (index >= text.length) {
    return undefined;
  }
  if (text[index] === '%') {
    return index + 1;
  }
  while (index < text.length && isFormatFlag(text[index])) {
    index++;
  }
  if (text[index] === '*') {
    index++;
  } else {
    while (index < text.length && isAsciiDigit(text[index])) {
      index++;
    }
  }
  if (text[index] === '.') {
    index++;
    while (index < text.length && isAsciiDigit(text[index])) {
      index++;
    }
  }
  while (index < text.length && isFormatLengthModifier(text[index])) {
    index++;
  }
  return index < text.length && isFormatConversion(text[index]) ? index + 1 : undefined;
}

function offsetRange(range: Range, start: number, end: number): Range {
  return Range.create(
    range.start.line,
    range.start.character + start,
    range.start.line,
    range.start.character + end
  );
}

function isFormatFlag(char: string): boolean {
  return char === '-' || char === '+' || char === '0' || char === '#' || char === ' ';
}

function isFormatLengthModifier(char: string): boolean {
  const lower = char.toLowerCase();
  return lower === 'h' || lower === 'l' || lower === 'm';
}

function isFormatConversion(char: string): boolean {
  const lower = char.toLowerCase();
  return lower >= 'a' && lower <= 'z';
}

function isAsciiDigit(char: string): boolean {
  return char >= '0' && char <= '9';
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
