import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition } from '../common/lsp';
import { rangeKey } from '../common/util';
import { collectAssignmentUsesFromModuleAst } from './assignmentAst';
import { declDetail } from './moduleUtils';
import { VerilogModule, VerilogParseResult } from './model';
import {
  resolveVerilogSemanticAtPosition,
  verilogSemanticReferenceRanges,
  verilogSemanticTargetFromSymbol,
  VerilogSemanticSymbol
} from './semanticModel';

/**
 * 一个信号"连线条目"的类别：是被赋值（驱动）还是被读取（使用）。
 */
export type SignalWiringEntryKind =
  | 'assign' // 连续赋值 assign x = ... 的 LHS
  | 'always' // always 块内 x <= ... / x = ... 的 LHS
  | 'instancePortDriver' // 子模块实例的 output 端口连到本信号（本信号被驱动）
  | 'instancePortReader' // 本信号连到子模块实例的 input/inout 端口（本信号被读取）
  | 'instancePort' // 连到实例端口但目标模块不在本文件，方向未知
  | 'instancePortUnresolved' // 目标模块跨文件且尚未被工作空间注册表解析
  | 'use'; // 出现在 RHS / 条件 / 其它读取位置

export interface SignalWiringEntry {
  kind: SignalWiringEntryKind;
  /** 跳转目标：该出现处的标识符范围（LSP Range）。 */
  range: Range;
  operator?: '=' | '<=';
  instanceName?: string;
  portName?: string;
}

export interface SignalWiringDeclaration {
  /** 形如 `wire [31:0] x` 的声明文本。 */
  detail: string;
  range: Range;
}

export interface SignalWiringReport {
  name: string;
  moduleName: string;
  declaration?: SignalWiringDeclaration;
  /** 写：assign / always LHS、以及驱动本信号的实例 output 端口。 */
  drivers: SignalWiringEntry[];
  /** 读：RHS / 条件 / 实例 input 端口连接。 */
  readers: SignalWiringEntry[];
  /** 尚未解析的实例端口连接：目标模块不在本文件且未被注册表找到。 */
  unresolved: SignalWiringEntry[];
}

interface InstancePortHit {
  expressionRange: Range;
  instanceName: string;
  portName?: string;
  direction?: 'input' | 'output' | 'inout';
  /** 目标模块在本文件内未找到，且外部注册表也未返回 */
  unresolved?: boolean;
}

const wireableSymbolKinds = new Set(['signal', 'port', 'parameter']);

/**
 * 分析光标处 Verilog 信号在其所属模块内的连线情况：声明、被谁驱动（写）、被谁读取（用）。
 * 纯函数，仅依赖一次解析结果，便于单测。光标不在可解析信号上时返回 undefined。
 *
 * v1 仅分析当前文件：实例端口方向依据本文件内可见的目标模块判定，跨文件目标标记为方向未知。
 */
export function analyzeSignalWiring(
  parsed: VerilogParseResult,
  document: TextDocument,
  position: Position,
  getExternalModule?: (name: string) => VerilogModule | undefined
): SignalWiringReport | undefined {
  const resolved = resolveVerilogSemanticAtPosition(parsed.semantic, position);
  const symbol = resolved?.symbol;
  if (!symbol || !wireableSymbolKinds.has(symbol.kind) || !symbol.module) {
    return undefined;
  }
  // task/function names are declared symbols (so they aren't flagged as implicit nets) but are
  // not wires; don't analyze their "wiring".
  if (symbol.decl?.kind === 'task' || symbol.decl?.kind === 'function') {
    return undefined;
  }
  const module = symbol.module;
  const name = symbol.name;

  const declaration = declarationOf(symbol);

  // 该信号的全部出现位置（不含声明本身）。其中既有读也有写。
  // 端口连接的"端口名"（如 `.clk(clk)` 中的 `.clk`）已由语义模型区分，不会并入本地同名信号。
  const occurrences = verilogSemanticReferenceRanges(
    parsed.semantic,
    verilogSemanticTargetFromSymbol(symbol),
    false
  );

  // 本模块内对该信号的写目标（assign / always LHS），含赋值运算符。
  const writes: SignalWiringEntry[] = [];
  const writeKeys = new Set<string>();
  const moduleAst = parsed.ast.modules.find((candidate) => candidate.module === module);
  if (moduleAst) {
    for (const assignment of collectAssignmentUsesFromModuleAst(document, moduleAst)) {
      if (assignment.name !== name) {
        continue;
      }
      writes.push({
        kind: assignment.blockIndex >= 0 ? 'always' : 'assign',
        range: assignment.range,
        operator: assignment.operator
      });
      writeKeys.add(rangeKey(assignment.range));
    }
  }

  const portHits = collectInstancePortHits(parsed, module, occurrences, getExternalModule);

  const drivers: SignalWiringEntry[] = [...writes];
  const readers: SignalWiringEntry[] = [];
  const unresolved: SignalWiringEntry[] = [];

  for (const range of occurrences) {
    if (writeKeys.has(rangeKey(range))) {
      continue; // 已作为 assign / always 写目标统计
    }
    const hit = portHits.find((candidate) => containsPosition(candidate.expressionRange, range.start));
    if (hit) {
      const meta = { instanceName: hit.instanceName, portName: hit.portName };
      if (hit.direction === 'output') {
        // 实例 output 端口驱动本信号 → 写
        drivers.push({ kind: 'instancePortDriver', range, ...meta });
      } else if (hit.direction === 'input') {
        // 本信号连到实例 input 端口 → 读
        readers.push({ kind: 'instancePortReader', range, ...meta });
      } else if (hit.direction === 'inout') {
        // inout 端口既驱动又读取本信号 → 同时计入两侧
        drivers.push({ kind: 'instancePortDriver', range, ...meta });
        readers.push({ kind: 'instancePortReader', range, ...meta });
      } else if (hit.unresolved) {
        // 目标模块未解析（跨文件且不在注册表中）
        unresolved.push({ kind: 'instancePortUnresolved', range, ...meta });
      } else {
        // 目标模块在同一文件但方向未知（不应该发生，但保留兜底）
        readers.push({ kind: 'instancePort', range, ...meta });
      }
      continue;
    }
    readers.push({ kind: 'use', range });
  }

  drivers.sort(compareEntries);
  readers.sort(compareEntries);
  unresolved.sort(compareEntries);

  return { name, moduleName: module.name, declaration, drivers, readers, unresolved };
}

function declarationOf(symbol: VerilogSemanticSymbol): SignalWiringDeclaration | undefined {
  const decl = symbol.decl;
  if (!decl) {
    return undefined;
  }
  return { detail: declDetail(decl), range: decl.selectionRange };
}

function collectInstancePortHits(
  parsed: VerilogParseResult,
  module: VerilogModule,
  occurrences: Range[],
  getExternalModule?: (name: string) => VerilogModule | undefined
): InstancePortHit[] {
  const hits: InstancePortHit[] = [];
  for (const instance of module.instances) {
    // 优先在当前文件查找目标模块
    let target = parsed.modules.find((candidate) => candidate.name === instance.moduleName);
    let unresolved = false;
    // 若当前文件没有，尝试通过外部注册表查找（跨文件）
    if (!target && getExternalModule) {
      target = getExternalModule(instance.moduleName);
    }
    // 如果仍未找到目标模块，标记为未解析
    if (!target) {
      unresolved = true;
    }
    for (const connection of instance.portConnections) {
      const referenced = occurrences.some((range) => containsPosition(connection.expressionRange, range.start));
      if (!referenced) {
        continue;
      }
      const port = connection.name
        ? target?.ports.find((candidate) => candidate.name === connection.name)
        : target?.ports[connection.positionalIndex];
      hits.push({
        expressionRange: connection.expressionRange,
        instanceName: instance.instanceName,
        portName: connection.name ?? port?.name,
        direction: port?.direction,
        unresolved: unresolved && !port
      });
    }
  }
  return hits;
}

function compareEntries(left: SignalWiringEntry, right: SignalWiringEntry): number {
  if (left.range.start.line !== right.range.start.line) {
    return left.range.start.line - right.range.start.line;
  }
  return left.range.start.character - right.range.start.character;
}
