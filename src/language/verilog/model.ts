import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, Position, Range } from 'vscode-languageserver/node';
import { buildExpectedPorts, profilesWithCapability } from '../../courseConfig';
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
  text: string;
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
  /**
   * Declared inside a generate block (`if`/`for`/`begin`), so its hierarchical
   * name carries an extra scope (`g[0].u`, `genblk1.u`) that the model omits.
   */
  inGenerateBlock?: boolean;
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
  /**
   * Scoped generate blocks (`begin ... end` inside generate constructs) with the
   * declarations local to each; nested blocks are separate entries.
   */
  generateBlocks: VerilogGenerateBlock[];
  range: Range;
  selectionRange: Range;
  headerEnd: Position;
  uri: string;
  bodyText: string;
  hasEndmodule: boolean;
  endmoduleRange?: Range;
}

export interface VerilogGenerateBlock {
  /** Block label (`g` in `begin : g`), when present. */
  name?: string;
  range: Range;
  /** Nets, variables and localparams declared directly in this block. */
  declarations: VerilogDecl[];
  /**
   * Conditional-generate branches enclosing (and including) this block, outermost
   * first. Blocks on different branches of the same `if`/`else` chain never
   * elaborate together.
   */
  branches: VerilogGenerateBranch[];
}

export interface VerilogGenerateBranch {
  /** Identifies one `if (...) ... else ...` construct within the module. */
  readonly construct: number;
  /** 0 for the `if` branch, 1 for its `else`. */
  readonly branch: number;
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
  'verilogTask',
  'verilogFunction'
] as const;

export type VerilogSemanticTokenType = typeof verilogSemanticTokenTypes[number];

interface VerilogLanguageCatalog {
  keywordGroups: Record<string, string[]>;
  compilerDirectives: string[];
  systemTasks: string[];
  operators: Record<string, string[]>;
}

export const verilogLanguageCatalog = loadVerilogLanguageCatalog();
export const verilogKeywords = new Set(Object.values(verilogLanguageCatalog.keywordGroups).flat());
export const systemTasks = new Set(verilogLanguageCatalog.systemTasks);

function loadVerilogLanguageCatalog(): VerilogLanguageCatalog {
  const filePath = path.resolve(__dirname, '../../../resources/verilog/keywords.json');
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<VerilogLanguageCatalog>;
  if (
    !parsed.keywordGroups ||
    !Array.isArray(parsed.compilerDirectives) ||
    !Array.isArray(parsed.systemTasks) ||
    !parsed.operators
  ) {
    throw new Error(`Invalid Verilog language catalog: ${filePath}`);
  }
  return parsed as VerilogLanguageCatalog;
}

// 保留旧对象形态供直接读取（向后兼容已加载的模块）
const _expected: Record<string, Record<string, string | undefined>> = {};
for (const p of profilesWithCapability('asmNeededForVerilog')) {
  _expected[p] = buildExpectedPorts(p);
}
export const expectedPorts: Record<string, Record<string, string | undefined>> = _expected;
