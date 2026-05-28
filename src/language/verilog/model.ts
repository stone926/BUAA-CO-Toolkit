import { Diagnostic, Position, Range } from 'vscode-languageserver/node';

export type VerilogDeclKind = 'input' | 'output' | 'inout' | 'wire' | 'reg' | 'logic' | 'integer' | 'parameter' | 'localparam' | 'genvar';

export interface VerilogDecl {
  name: string;
  kind: VerilogDeclKind;
  width?: string;
  range: Range;
  selectionRange: Range;
  direction?: 'input' | 'output' | 'inout';
}

export interface VerilogInstance {
  moduleName: string;
  instanceName: string;
  range: Range;
  selectionRange: Range;
}

export interface VerilogModule {
  name: string;
  ports: VerilogDecl[];
  declarations: Map<string, VerilogDecl>;
  instances: VerilogInstance[];
  range: Range;
  selectionRange: Range;
  headerEnd: Position;
  uri: string;
  bodyText: string;
}

export interface VerilogMacro {
  name: string;
  range: Range;
  selectionRange: Range;
}

export interface VerilogParseResult {
  modules: VerilogModule[];
  macros: VerilogMacro[];
  diagnostics: Diagnostic[];
}

export const verilogKeywords = new Set([
  'always',
  'and',
  'assign',
  'begin',
  'case',
  'casex',
  'casez',
  'default',
  'defparam',
  'else',
  'end',
  'endcase',
  'endfunction',
  'endgenerate',
  'endmodule',
  'endtask',
  'for',
  'forever',
  'function',
  'generate',
  'genvar',
  'if',
  'initial',
  'inout',
  'input',
  'integer',
  'localparam',
  'module',
  'negedge',
  'or',
  'output',
  'parameter',
  'posedge',
  'reg',
  'repeat',
  'signed',
  'task',
  'wire',
  'while',
  'logic'
]);

export const systemTasks = new Set([
  'display',
  'monitor',
  'finish',
  'stop',
  'readmemh',
  'readmemb',
  'dumpfile',
  'dumpvars',
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

