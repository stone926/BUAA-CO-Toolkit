import {
  MarkupKind,
  Position,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { getCachedMipsParse } from './parseCache';
import {
  instructions,
  instructionTypeLabel
} from './resources';
import { MipsServerState } from './state';
import type { MipsExecutableAst } from './ast';

export function getMipsSignatureHelp(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): SignatureHelp | undefined {
  const parsed = getCachedMipsParse(document, settings, state);
  const line = parsed.ast.lines[position.line];
  const executable = line?.kind === 'statement' ? line.executable : undefined;
  if (!executable) {
    return undefined;
  }

  const name = executable.mnemonic;
  if (position.character < executable.mnemonicRange.end.character) {
    return undefined;
  }
  if (line.kind === 'statement' && line.comment && position.character >= line.comment.range.start.character) {
    return undefined;
  }
  const activeParameter = activeParameterFromOperands(executable, position.character);

  const instruction = instructions[name.toLowerCase()];
  if (instruction) {
    return buildInstructionSignatureHelp(instruction, activeParameter);
  }

  const macroOverloads = parsed.semantic.macros.filter((macro) => macro.name === name);
  if (macroOverloads.length) {
    return buildMacroSignatureHelp(macroOverloads, activeParameter);
  }

  return undefined;
}

function activeParameterFromOperands(executable: MipsExecutableAst, character: number): number {
  if (!executable.operandRange || character <= executable.operandRange.start.character || executable.operands.length === 0) {
    return 0;
  }

  for (let index = 0; index < executable.operands.length; index++) {
    const operand = executable.operands[index];
    if (character <= operand.range.end.character) {
      return index;
    }
    const next = executable.operands[index + 1];
    if (!next || character < next.range.start.character) {
      return Math.min(index + 1, executable.operands.length - 1);
    }
  }

  return executable.operands.length - 1;
}

function buildInstructionSignatureHelp(instruction: { mnemonic: string; summary: string; type: string; formats: string[]; operands: [number, number]; description: string; pseudo?: boolean }, activeParameter: number): SignatureHelp {
  const signatures: SignatureInformation[] = [];

  for (const format of instruction.formats) {
    const params = extractFormatParameters(format);
    const paramInfos: ParameterInformation[] = params.map((param) => ({
      label: param
    }));

    signatures.push({
      label: format,
      documentation: {
        kind: MarkupKind.Markdown,
        value: [
          `**${instruction.mnemonic}** - ${instruction.summary}`,
          '',
          `Type: ${instructionTypeLabel(instruction.type as any)}`,
          '',
          instruction.description
        ].join('\n')
      },
      parameters: paramInfos
    });
  }

  if (signatures.length === 0) {
    return { signatures: [], activeParameter: 0, activeSignature: 0 };
  }

  // Pick the best signature based on active parameter count
  let activeSignature = 0;
  for (let i = 0; i < signatures.length; i++) {
    const paramCount = signatures[i].parameters?.length ?? 0;
    if (activeParameter < paramCount) {
      activeSignature = i;
      break;
    }
  }

  return {
    signatures,
    activeParameter: clampActiveParameter(activeParameter, signatures[activeSignature].parameters?.length ?? 0),
    activeSignature
  };
}

function buildMacroSignatureHelp(overloads: { name: string; params: string[] }[], activeParameter: number): SignatureHelp {
  const signatures: SignatureInformation[] = overloads.map((macro) => {
    const paramInfos: ParameterInformation[] = macro.params.map((param) => ({
      label: param
    }));
    return {
      label: `${macro.name}(${macro.params.join(', ')})`,
      documentation: {
        kind: MarkupKind.Markdown,
        value: `Macro \`${macro.name}\` with ${macro.params.length} parameter(s).`
      },
      parameters: paramInfos
    };
  });

  // Pick the best overload
  let activeSignature = 0;
  for (let i = 0; i < overloads.length; i++) {
    if (activeParameter < overloads[i].params.length) {
      activeSignature = i;
      break;
    }
  }

  return {
    signatures,
    activeParameter: clampActiveParameter(activeParameter, signatures[activeSignature].parameters?.length ?? 0),
    activeSignature
  };
}

function extractFormatParameters(format: string): string[] {
  const operandStart = firstWhitespaceIndex(format);
  if (operandStart < 0) {
    return [];
  }
  return splitCommaList(format.slice(operandStart)).map((part) => part.trim()).filter(Boolean);
}

function firstWhitespaceIndex(text: string): number {
  for (let index = 0; index < text.length; index++) {
    if (isAsciiWhitespace(text[index])) {
      return index;
    }
  }
  return -1;
}

function splitCommaList(text: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      values.push(text.slice(start, index));
      start = index + 1;
    }
  }
  values.push(text.slice(start));
  return values;
}

function clampActiveParameter(activeParameter: number, parameterCount: number): number {
  if (parameterCount <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(activeParameter, parameterCount - 1));
}

function isAsciiWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
}
