import { Diagnostic, Range } from 'vscode-languageserver/node';

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
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
  macros: Map<string, MipsMacro[]>;
  instructions: MipsLine[];
  diagnostics: Diagnostic[];
}

export interface MipsParseOptions {
  includeDiagnostics?: boolean;
  ignoredPseudoInstructionFiles?: Set<string>;
  ignoredPseudoInstructionMnemonics?: Set<string>;
}
