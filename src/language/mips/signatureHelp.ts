import {
  MarkupKind,
  Position,
  SignatureHelp,
  SignatureHelpTriggerKind,
  SignatureInformation,
  ParameterInformation
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  allMacros,
  findMacroAtPosition
} from './parser';
import { getCachedMipsParse } from './parseCache';
import {
  instructions,
  instructionTypeLabel
} from './resources';
import { MipsServerState } from './state';
import { stripComment } from './syntax';

export function getMipsSignatureHelp(document: TextDocument, position: Position, settings: CoSettings, state: MipsServerState): SignatureHelp | undefined {
  const line = lineAt(document, position.line).text;
  const code = stripComment(line);
  const prefix = code.slice(0, position.character);

  // Find the instruction or macro name
  const tokenMatch = prefix.match(/^\s*(?:[A-Za-z_.$][\w.$]*:\s*)*(?:([A-Za-z_.$][\w.$]*)\s*)(.*)/);
  if (!tokenMatch) {
    return undefined;
  }

  const name = tokenMatch[1];
  const operandPrefix = tokenMatch[2];

  // Count active parameter by counting commas (respecting parentheses for macro args)
  const activeParameter = countActiveParameter(operandPrefix);

  // Try instruction signature help
  const instruction = instructions[name.toLowerCase()];
  if (instruction) {
    return buildInstructionSignatureHelp(instruction, activeParameter);
  }

  // Try macro signature help
  const parsed = getCachedMipsParse(document, settings, state);
  const macroOverloads = parsed.macros.get(name);
  if (macroOverloads?.length) {
    return buildMacroSignatureHelp(macroOverloads, activeParameter);
  }

  return undefined;
}

function countActiveParameter(operandText: string): number {
  let count = 0;
  let depth = 0;
  for (const char of operandText) {
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
    } else if (char === ',' && depth === 0) {
      count++;
    }
  }
  return count;
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
    activeParameter: Math.min(activeParameter, (signatures[activeSignature].parameters?.length ?? 1) - 1),
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
    activeParameter: Math.min(activeParameter, (signatures[activeSignature].parameters?.length ?? 1) - 1),
    activeSignature
  };
}

function extractFormatParameters(format: string): string[] {
  // Extract parameter names from format strings like "add $rd, $rs, $rt"
  const parts = format.split(/\s+/);
  if (parts.length < 2) {
    return [];
  }
  // Skip the mnemonic, take operands
  return parts.slice(1).join(' ').split(',').map((p) => p.trim()).filter(Boolean);
}
