import { Diagnostic, Position, Range } from 'vscode-languageserver/node';
import type { VerilogAstDocument } from './ast';
import type { VerilogSemanticModel } from './semanticModel';
import type { VerilogExpressionAst } from './exprAst';

export type VerilogDeclKind = 'input' | 'output' | 'inout' | 'wire' | 'reg' | 'logic' | 'integer' | 'real' | 'realtime' | 'time' | 'parameter' | 'localparam' | 'genvar' | 'task' | 'function';

export interface VerilogDecl {
  name: string;
  kind: VerilogDeclKind;
  width?: string;
  widthRange?: Range;
  widthAst?: VerilogExpressionAst[];
  unpackedDimensions?: VerilogDeclDimension[];
  initializer?: string;
  initializerRange?: Range;
  initializerAst?: VerilogExpressionAst;
  constantValue?: bigint;
  inferredWidth?: number;
  inferredMinWidth?: number;
  inferredFlexible?: boolean;
  range: Range;
  selectionRange: Range;
  direction?: 'input' | 'output' | 'inout';
  directionRange?: Range;
  explicitPortNetType?: boolean;
}

export interface VerilogDeclDimension {
  range: Range;
  expressions: VerilogExpressionAst[];
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
  expressionAst?: VerilogExpressionAst;
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
  body?: string;
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

export interface VerilogDirective {
  name: string;
  argument?: string;
  range: Range;
  selectionRange: Range;
  argumentRange?: Range;
}

export interface VerilogParseResult {
  ast: VerilogAstDocument;
  semantic: VerilogSemanticModel;
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

import { buildExpectedPorts } from '../../courseConfig';

/**
 * 期望的 Verilog 顶层端口定义（按 Profile）。
 * 数据来源为 resources/co/courseConfig.json 的 verilogPorts，
 * 通过 courseConfig.buildExpectedPorts() 转换为 expectedPorts 格式。
 */
export function getExpectedPorts(profile: string): Record<string, string | undefined> {
  return buildExpectedPorts(profile);
}

// 保留旧对象形态供直接读取（向后兼容已加载的模块）
const _expected: Record<string, Record<string, string | undefined>> = {};
for (const p of ['P4', 'P5', 'P6', 'P7']) {
  _expected[p] = buildExpectedPorts(p);
}
export const expectedPorts: Record<string, Record<string, string | undefined>> = _expected;
