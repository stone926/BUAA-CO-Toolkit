import { Position, Range } from 'vscode-languageserver/node';
import {
  findMacroAtPosition,
  getDeclarationRangeSet
} from './parser';
import { MipsMacro, MipsParseResult } from './model';
import { parseMacroArguments } from './syntax';
import { rangeKey } from '../common/util';

export function findMacroOverloadAtPosition(parsed: MipsParseResult, name: string, position: Position): MipsMacro | undefined {
  const currentMacro = findMacroAtPosition(parsed, position);
  if (currentMacro?.name === name) {
    return currentMacro;
  }

  const overloads = parsed.macros.get(name) ?? [];
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
  const line = parsed.lines[position.line];
  if (line?.kind !== 'statement' || !line.executable || line.executable.mnemonic !== name) {
    return undefined;
  }

  const executable = line.executable;
  if (position.character < executable.range.start || position.character > executable.range.end) {
    return undefined;
  }
  return parseMacroArguments(executable.operandText);
}

/**
 * O(1) 声明范围查找，使用预计算的 rangeKey 集合。
 */
export function isKnownDeclarationRange(range: Range, parsed: MipsParseResult): boolean {
  return getDeclarationRangeSet(parsed).has(rangeKey(range));
}
