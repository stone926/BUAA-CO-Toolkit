export type SemanticColorPresetName = 'dark' | 'light';

export const semanticColorPresetSetting = 'semanticColors.preset';

export const semanticColorTokenIds = [
  'mipsInstruction',
  'mipsRealInstruction',
  'mipsRInstruction',
  'mipsIInstruction',
  'mipsJInstruction',
  'mipsSpecialInstruction',
  'mipsPseudoInstruction',
  'mipsRegister',
  'mipsCp0Register',
  'mipsMacro',
  'mipsMacroParameter',
  'mipsLabel',
  'mipsDataSymbol',
  'mipsEqvSymbol',
  'verilogModule',
  'verilogPort',
  'verilogSignal',
  'verilogParameter',
  'verilogInstance',
  'verilogMacro',
  'verilogTask',
  'verilogFunction'
] as const;

export type SemanticColorTokenId = typeof semanticColorTokenIds[number];

export const semanticColorPresets: Record<SemanticColorPresetName, Record<SemanticColorTokenId, string>> = {
  dark: {
    mipsInstruction: '#9CDCFE',
    mipsRealInstruction: '#9CDCFE',
    mipsRInstruction: '#9CDCFE',
    mipsIInstruction: '#4EC9B0',
    mipsJInstruction: '#569CD6',
    mipsSpecialInstruction: '#F44747',
    mipsPseudoInstruction: '#D7BA7D',
    mipsRegister: '#4FC1FF',
    mipsCp0Register: '#B8D7FF',
    mipsMacro: '#569CD6',
    mipsMacroParameter: '#FFCB6B',
    mipsLabel: '#C586C0',
    mipsDataSymbol: '#DCDCAA',
    mipsEqvSymbol: '#C3E88D',
    verilogModule: '#4EC9B0',
    verilogPort: '#9CDCFE',
    verilogSignal: '#9CDCFE',
    verilogParameter: '#D7BA7D',
    verilogInstance: '#DCDCAA',
    verilogMacro: '#C586C0',
    verilogTask: '#DCDCAA',
    verilogFunction: '#DCDCAA'
  },
  light: {
    mipsInstruction: '#001080',
    mipsRealInstruction: '#001080',
    mipsRInstruction: '#001080',
    mipsIInstruction: '#267F99',
    mipsJInstruction: '#0000FF',
    mipsSpecialInstruction: '#A31515',
    mipsPseudoInstruction: '#795E26',
    mipsRegister: '#0070C1',
    mipsCp0Register: '#0451A5',
    mipsMacro: '#0000FF',
    mipsMacroParameter: '#B000B0',
    mipsLabel: '#AF00DB',
    mipsDataSymbol: '#795E26',
    mipsEqvSymbol: '#098658',
    verilogModule: '#267F99',
    verilogPort: '#001080',
    verilogSignal: '#001080',
    verilogParameter: '#795E26',
    verilogInstance: '#795E26',
    verilogMacro: '#AF00DB',
    verilogTask: '#795E26',
    verilogFunction: '#795E26'
  }
};
