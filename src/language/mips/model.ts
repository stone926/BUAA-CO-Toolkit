import { Diagnostic, Range } from 'vscode-languageserver/node';
import type { MipsCstLine } from './syntax';

export interface MipsSymbol {
  name: string;
  kind: 'label' | 'data' | 'eqv' | 'macro' | 'macroParam';
  range: Range;
  selectionRange: Range;
  detail?: string;
  macroName?: string;
}

export interface MipsMacro {
  name: string;
  params: string[];
  paramSymbols: Map<string, MipsSymbol>;
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  range: Range;
  selectionRange: Range;
  bodyStartLine: number;
  bodyEndLine?: number;
}

export interface MipsLine {
  line: number;
  mnemonic: string;
  operands: string[];
  range: Range;
  usesPseudoForm: boolean;
}

export interface MipsLabelReference {
  line: number;
  operand: string;
  macro?: MipsMacro;
}

export interface MipsParseResult {
  lines: MipsCstLine[];
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  macros: Map<string, MipsMacro[]>;
  instructions: MipsLine[];
  diagnostics: Diagnostic[];

  /** 惰性缓存：展开后的所有宏（含重载），避免重复 flat */
  _allMacros?: MipsMacro[];
  /** 惰性缓存：展开后的所有符号（labels + data + eqv + 宏内符号 + 宏参数） */
  _allSymbols?: MipsSymbol[];
  /** 惰性缓存：所有声明 Range 的字符串键集合，用于 O(1) 查找 */
  _declarationRangeKeys?: Set<string>;
}

export interface MipsParseOptions {
  includeDiagnostics?: boolean;
  ignoredPseudoInstructionFiles?: Set<string>;
  ignoredPseudoInstructionMnemonics?: Set<string>;
}
