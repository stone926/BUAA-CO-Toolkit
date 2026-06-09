import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition } from '../common/lsp';
import { rangeKey } from '../common/util';
import { collectAssignmentsFromTokens } from './assignmentAnalysis';
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
}

interface InstancePortHit {
  expressionRange: Range;
  instanceName: string;
  portName?: string;
  direction?: 'input' | 'output' | 'inout';
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
  position: Position
): SignalWiringReport | undefined {
  const resolved = resolveVerilogSemanticAtPosition(parsed.semantic, position);
  const symbol = resolved?.symbol;
  if (!symbol || !wireableSymbolKinds.has(symbol.kind) || !symbol.module) {
    return undefined;
  }
  const module = symbol.module;
  const name = symbol.name;

  const declaration = declarationOf(symbol);

  // 该信号的全部出现位置（不含声明本身）。其中既有读也有写。
  const occurrences = verilogSemanticReferenceRanges(
    parsed.semantic,
    verilogSemanticTargetFromSymbol(symbol),
    false
  );

  // 本模块内对该信号的写目标（assign / always LHS），含赋值运算符。
  const writes: SignalWiringEntry[] = [];
  const writeKeys = new Set<string>();
  for (const assignment of collectAssignmentsFromTokens(document, parsed.cst, 0, -1)) {
    if (assignment.name === name && containsPosition(module.range, assignment.range.start)) {
      writes.push({
        kind: assignment.operator === '<=' ? 'always' : 'assign',
        range: assignment.range,
        operator: assignment.operator
      });
      writeKeys.add(rangeKey(assignment.range));
    }
  }

  const portHits = collectInstancePortHits(parsed, module, occurrences);

  const drivers: SignalWiringEntry[] = [...writes];
  const readers: SignalWiringEntry[] = [];

  for (const range of occurrences) {
    if (writeKeys.has(rangeKey(range))) {
      continue; // 已作为 assign / always 写目标统计
    }
    const hit = portHits.find((candidate) => containsPosition(candidate.expressionRange, range.start));
    if (hit) {
      if (hit.direction === 'output') {
        drivers.push({ kind: 'instancePortDriver', range, instanceName: hit.instanceName, portName: hit.portName });
      } else if (hit.direction === 'input' || hit.direction === 'inout') {
        readers.push({ kind: 'instancePortReader', range, instanceName: hit.instanceName, portName: hit.portName });
      } else {
        readers.push({ kind: 'instancePort', range, instanceName: hit.instanceName, portName: hit.portName });
      }
      continue;
    }
    readers.push({ kind: 'use', range });
  }

  drivers.sort(compareEntries);
  readers.sort(compareEntries);

  return { name, moduleName: module.name, declaration, drivers, readers };
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
  occurrences: Range[]
): InstancePortHit[] {
  const hits: InstancePortHit[] = [];
  for (const instance of module.instances) {
    const target = parsed.modules.find((candidate) => candidate.name === instance.moduleName);
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
        direction: port?.direction
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
