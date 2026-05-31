import { Diagnostic, Position, Range } from 'vscode-languageserver/node';

export type VerilogDeclKind = 'input' | 'output' | 'inout' | 'wire' | 'reg' | 'logic' | 'integer' | 'real' | 'realtime' | 'time' | 'parameter' | 'localparam' | 'genvar';

export interface VerilogDecl {
  name: string;
  kind: VerilogDeclKind;
  width?: string;
  inferredWidth?: number;
  inferredMinWidth?: number;
  inferredFlexible?: boolean;
  range: Range;
  selectionRange: Range;
  direction?: 'input' | 'output' | 'inout';
}

export interface VerilogInstance {
  moduleName: string;
  instanceName: string;
  range: Range;
  moduleSelectionRange: Range;
  selectionRange: Range;
  portListRange?: Range;
  parameterListRange?: Range;
  portConnections: VerilogPortConnection[];
  parameterConnections: VerilogPortConnection[];
}

export interface VerilogPortConnection {
  name?: string;
  nameRange?: Range;
  expression: string;
  expressionRange: Range;
  range: Range;
  positionalIndex: number;
  shorthand?: boolean;
}

export interface VerilogModule {
  name: string;
  ports: VerilogDecl[];
  parameters: VerilogDecl[];
  declarations: Map<string, VerilogDecl>;
  instances: VerilogInstance[];
  range: Range;
  selectionRange: Range;
  headerEnd: Position;
  uri: string;
  bodyText: string;
  hasEndmodule: boolean;
  endmoduleRange?: Range;
}

export interface VerilogMacro {
  name: string;
  range: Range;
  selectionRange: Range;
}

export interface VerilogMacroUse {
  name: string;
  range: Range;
  selectionRange: Range;
}

export interface VerilogInclude {
  path: string;
  range: Range;
  pathRange: Range;
}

export interface VerilogParseResult {
  modules: VerilogModule[];
  macros: VerilogMacro[];
  macroUses: VerilogMacroUse[];
  includes: VerilogInclude[];
  diagnostics: Diagnostic[];
}

export const verilogSemanticTokenTypes = [
  'verilogModule',
  'verilogPort',
  'verilogSignal',
  'verilogParameter',
  'verilogInstance',
  'verilogMacro',
  'verilogSystemTask',
  'verilogNumber',
  'verilogKeyword',
  'verilogComment',
  'verilogString',
  'verilogFormatSpecifier',
  'verilogPunctuation'
] as const;

export type VerilogSemanticTokenType = typeof verilogSemanticTokenTypes[number];

export const verilogKeywords = new Set([
  'always',
  'automatic',
  'and',
  'assign',
  'begin',
  'buf',
  'bufif0',
  'bufif1',
  'case',
  'casex',
  'casez',
  'cell',
  'cmos',
  'config',
  'deassign',
  'default',
  'defparam',
  'design',
  'disable',
  'edge',
  'else',
  'end',
  'endcase',
  'endconfig',
  'endfunction',
  'endgenerate',
  'endmodule',
  'endprimitive',
  'endspecify',
  'endtable',
  'endtask',
  'event',
  'for',
  'force',
  'forever',
  'fork',
  'function',
  'generate',
  'genvar',
  'highz0',
  'highz1',
  'if',
  'ifnone',
  'ifdef',
  'ifndef',
  'incdir',
  'include',
  'initial',
  'inout',
  'input',
  'instance',
  'integer',
  'join',
  'large',
  'liblist',
  'library',
  'localparam',
  'macromodule',
  'medium',
  'module',
  'nand',
  'negedge',
  'nmos',
  'nor',
  'noshowcancelled',
  'not',
  'notif0',
  'notif1',
  'or',
  'output',
  'parameter',
  'pmos',
  'posedge',
  'primitive',
  'pull0',
  'pull1',
  'pulldown',
  'pullup',
  'pulsestyle_onevent',
  'pulsestyle_ondetect',
  'rcmos',
  'real',
  'realtime',
  'reg',
  'release',
  'repeat',
  'rnmos',
  'rpmos',
  'rtran',
  'rtranif0',
  'rtranif1',
  'scalared',
  'signed',
  'showcancelled',
  'small',
  'specify',
  'specparam',
  'strong0',
  'strong1',
  'supply0',
  'supply1',
  'table',
  'task',
  'time',
  'tran',
  'tranif0',
  'tranif1',
  'tri',
  'tri0',
  'tri1',
  'triand',
  'trior',
  'trireg',
  'unsigned',
  'use',
  'vectored',
  'wait',
  'wand',
  'weak0',
  'weak1',
  'wire',
  'wor',
  'while',
  'logic',
  'xnor',
  'xor'
]);

export const systemTasks = new Set([
  'display',
  'write',
  'monitor',
  'finish',
  'stop',
  'readmemh',
  'readmemb',
  'dumpfile',
  'dumpvars',
  'signed',
  'unsigned',
  'clog2',
  'random',
  'fopen',
  'fclose',
  'fdisplay',
  'fwrite',
  'fflush',
  'fsdbDumpfile',
  'fsdbDumpvars',
  'time'
]);

export const expectedPorts: Record<string, Record<string, string | undefined>> = {
  P4: {
    clk: undefined,
    reset: undefined
  },
  P5: {
    clk: undefined,
    reset: undefined
  },
  P6: {
    clk: undefined,
    reset: undefined,
    i_inst_rdata: '[31:0]',
    m_data_rdata: '[31:0]',
    i_inst_addr: '[31:0]',
    m_data_addr: '[31:0]',
    m_data_wdata: '[31:0]',
    m_data_byteen: '[3:0]',
    m_inst_addr: '[31:0]',
    w_grf_we: undefined,
    w_grf_addr: '[4:0]',
    w_grf_wdata: '[31:0]',
    w_inst_addr: '[31:0]'
  },
  P7: {
    clk: undefined,
    reset: undefined,
    interrupt: undefined,
    macroscopic_pc: '[31:0]',
    i_inst_addr: '[31:0]',
    i_inst_rdata: '[31:0]',
    m_data_addr: '[31:0]',
    m_data_rdata: '[31:0]',
    m_data_wdata: '[31:0]',
    m_data_byteen: '[3:0]',
    m_int_addr: '[31:0]',
    m_int_byteen: '[3:0]',
    m_inst_addr: '[31:0]',
    w_grf_we: undefined,
    w_grf_addr: '[4:0]',
    w_grf_wdata: '[31:0]',
    w_inst_addr: '[31:0]'
  }
};
