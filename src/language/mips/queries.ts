import { Position } from 'vscode-languageserver/node';
import { containsPosition } from '../common/lsp';
import {
  resolveMipsSemanticMacroAtPosition
} from './semantic';
import { MipsMacro, MipsParseResult } from './model';

export function findMacroOverloadAtPosition(parsed: MipsParseResult, name: string, position: Position): MipsMacro | undefined {
  const semanticMacro = resolveMipsSemanticMacroAtPosition(parsed.semantic, name, position);
  if (semanticMacro) {
    return semanticMacro;
  }

  const overloads = parsed.semantic.macros.filter((macro) => macro.name === name);
  if (!overloads.length) {
    return undefined;
  }

  const callArgs = macroCallArgumentsAtPosition(parsed, name, position);
  if (callArgs !== undefined) {
    return overloads.find((macro) => macro.params.length === callArgs.length) ?? overloads[0];
  }

  return overloads[0];
}

export function macroCallArgumentsAtPosition(parsed: MipsParseResult, name: string, position: Position): string[] | undefined {
  const line = parsed.ast.lines[position.line];
  const executable = line?.kind === 'statement' ? line.executable : undefined;
  if (!executable || executable.mnemonic !== name) {
    return undefined;
  }

  if (!containsPosition(executable.range, position)) {
    return undefined;
  }
  return executable.macroArguments.map((argument) => argument.text);
}
