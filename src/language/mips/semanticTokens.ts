import { Range, SemanticTokens } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentResultCache } from '../common/documentResultCache';
import { SemanticTokenCollector } from '../common/semanticTokens';
import { CoSettings } from '../common/settings';
import { rangeKey } from '../common/util';
import type { MipsAstLine, MipsOperandAst } from './ast';
import { cp0RegisterAtPosition } from './display';
import { collectMipsOperandReferences } from './operandReferences';
import { getCachedMipsSemanticParse } from './parseCache';
import {
  instructions,
  instructionSemanticTokenType,
  isFloatingPointRegister,
  isRegister,
  MipsSemanticTokenType,
  mipsSemanticTokenTypes
} from './resources';
import { MipsSemanticReferenceKind } from './semantic';
import { MipsServerState } from './state';

const semanticTokenCache = new DocumentResultCache<SemanticTokens>();

export function getMipsSemanticTokens(document: TextDocument, settings: CoSettings, state: MipsServerState): SemanticTokens {
  return semanticTokenCache.getOrCreate(
    document,
    `mips-semantic:${settings.mips.instructionColorMode}`,
    () => buildMipsSemanticTokens(document, settings, state)
  );
}

export function clearMipsSemanticTokenCache(uri?: string): void {
  semanticTokenCache.clear(uri);
}

function buildMipsSemanticTokens(document: TextDocument, settings: CoSettings, state: MipsServerState): SemanticTokens {
  const parsed = getCachedMipsSemanticParse(document, settings, state);
  const collector = new SemanticTokenCollector(mipsSemanticTokenTypes);
  const semanticReferences = new Map(parsed.semantic.references.map((reference) => [rangeKey(reference.range), reference]));
  const instructionByRange = new Map(parsed.instructions.map((line) => [rangeKey(line.range), line]));

  for (const declaration of parsed.semantic.declarations) {
    const tokenType = declaration.macro
      ? 'mipsMacro'
      : declaration.symbol
        ? semanticSymbolTokenType(declaration.symbol.kind)
        : undefined;
    if (tokenType) {
      collector.add(declaration.selectionRange, tokenType, ['declaration']);
    }
  }

  for (const line of parsed.ast.lines) {
    collectLineTokens(collector, line, parsed, settings, semanticReferences, instructionByRange);
  }
  return collector.build();
}

function collectLineTokens(
  collector: SemanticTokenCollector<MipsSemanticTokenType>,
  line: MipsAstLine,
  parsed: ReturnType<typeof getCachedMipsSemanticParse>,
  settings: CoSettings,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>,
  instructionByRange: Map<string, { usesPseudoForm: boolean }>
): void {
  if (line.kind !== 'statement' || !line.executable) {
    return;
  }
  const executable = line.executable;
  collectMnemonicToken(
    collector,
    parsed,
    settings,
    semanticReferences,
    instructionByRange,
    executable.mnemonic,
    executable.mnemonicRange
  );
  for (const operand of executable.operands) {
    collectOperandTokens(collector, operand, parsed, semanticReferences);
  }
}

function collectOperandTokens(
  collector: SemanticTokenCollector<MipsSemanticTokenType>,
  operand: MipsOperandAst,
  parsed: ReturnType<typeof getCachedMipsSemanticParse>,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>
): void {
  if (parsed.semantic.declarationRangeKeys.has(rangeKey(operand.range))) {
    return;
  }
  switch (operand.kind) {
    case 'memory':
      collectOperandTokens(collector, operand.offset, parsed, semanticReferences);
      collectOperandTokens(collector, operand.base, parsed, semanticReferences);
      return;
    case 'register':
      collectRegisterToken(collector, parsed, operand.text, operand.range);
      return;
    case 'macroParameter':
    case 'symbol':
      collectReferenceToken(collector, semanticReferences, operand.range);
      return;
    case 'expression':
      collectExpressionTokens(collector, operand, parsed, semanticReferences);
      return;
    case 'string':
    case 'integer':
    case 'float':
      return;
  }
}

function collectExpressionTokens(
  collector: SemanticTokenCollector<MipsSemanticTokenType>,
  operand: MipsOperandAst,
  parsed: ReturnType<typeof getCachedMipsSemanticParse>,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>
): void {
  for (const reference of collectMipsOperandReferences(operand, { includeRegisters: true })) {
    if (parsed.semantic.declarationRangeKeys.has(rangeKey(reference.range))) {
      continue;
    }
    if (reference.text.startsWith('$') && (isRegister(reference.text) || isFloatingPointRegister(reference.text))) {
      collectRegisterToken(collector, parsed, reference.text, reference.range);
    } else {
      collectReferenceToken(collector, semanticReferences, reference.range);
    }
  }
}

function collectMnemonicToken(
  collector: SemanticTokenCollector<MipsSemanticTokenType>,
  parsed: ReturnType<typeof getCachedMipsSemanticParse>,
  settings: CoSettings,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>,
  instructionByRange: Map<string, { usesPseudoForm: boolean }>,
  text: string,
  range: Range
): void {
  const key = rangeKey(range);
  if (parsed.semantic.declarationRangeKeys.has(key)) {
    return;
  }
  const reference = semanticReferences.get(key);
  const referenceType = reference ? semanticReferenceTokenType(reference.kind) : undefined;
  if (referenceType) {
    collector.add(range, referenceType);
    return;
  }
  const instruction = instructions[text.toLowerCase()];
  if (instruction) {
    const parsedInstruction = instructionByRange.get(key);
    collector.add(range, instructionSemanticTokenType(instruction, settings, parsedInstruction?.usesPseudoForm));
  }
}

function collectReferenceToken(
  collector: SemanticTokenCollector<MipsSemanticTokenType>,
  semanticReferences: Map<string, { kind: MipsSemanticReferenceKind }>,
  range: Range
): void {
  const reference = semanticReferences.get(rangeKey(range));
  const tokenType = reference ? semanticReferenceTokenType(reference.kind) : undefined;
  if (tokenType) {
    collector.add(range, tokenType);
  }
}

function collectRegisterToken(
  collector: SemanticTokenCollector<MipsSemanticTokenType>,
  parsed: ReturnType<typeof getCachedMipsSemanticParse>,
  text: string,
  range: Range
): void {
  if (cp0RegisterAtPosition(parsed, text, range.start)) {
    collector.add(range, 'mipsCp0Register');
  } else if (isRegister(text) || isFloatingPointRegister(text)) {
    collector.add(range, 'mipsRegister');
  }
}

function semanticSymbolTokenType(kind: string): MipsSemanticTokenType | undefined {
  switch (kind) {
    case 'label':
      return 'mipsLabel';
    case 'data':
      return 'mipsDataSymbol';
    case 'eqv':
      return 'mipsEqvSymbol';
    case 'macroParam':
      return 'mipsMacroParameter';
    default:
      return undefined;
  }
}

function semanticReferenceTokenType(kind: MipsSemanticReferenceKind): MipsSemanticTokenType | undefined {
  switch (kind) {
    case 'label':
      return 'mipsLabel';
    case 'data':
      return 'mipsDataSymbol';
    case 'eqv':
      return 'mipsEqvSymbol';
    case 'macro':
      return 'mipsMacro';
    case 'macroParam':
      return 'mipsMacroParameter';
    default:
      return undefined;
  }
}
