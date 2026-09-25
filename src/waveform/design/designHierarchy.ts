// @index waveform-design — 设计层次遍历（纯模型）：按实例名解析 VCD 层次路径到模块，并在 testbench 之下查找可逐字 dump 的小存储器

import { containsRange } from '../../language/common/lsp';
import { evalExpressionAstConstant, VerilogConstantOverrides } from '../../language/verilog/expressions';
import type { VerilogDecl, VerilogInstance, VerilogModule } from '../../language/verilog/model';
import { resolveParameterOverrides } from '../../language/verilog/parameterOverrides';

export type ModuleLookup = (name: string) => VerilogModule | undefined;

export interface HierarchyResolution {
  /** Module that owns the last resolved segment. */
  readonly module: VerilogModule;
  /** Instance that created `module`, when the path descended at least once. */
  readonly instance?: { readonly parent: VerilogModule; readonly instance: VerilogInstance };
  /**
   * Named-block segments after the last instance, outermost first, without
   * generate-loop indices (`lane[0]` becomes `lane`).
   */
  readonly blocks: readonly string[];
}

/**
 * Follow instance names from `root`. Segments that name no instance (named
 * begin/generate blocks, tasks) keep the current module, because their
 * declarations still live in that module's source.
 */
export function resolveHierarchy(root: VerilogModule, segments: readonly string[], lookup: ModuleLookup): HierarchyResolution {
  let module = root;
  let created: HierarchyResolution['instance'];
  let blocks: string[] = [];
  const visited = new Set<VerilogModule>([root]);
  for (const segment of segments) {
    const instance = module.instances.find((candidate) => candidate.instanceName === segment);
    const target = instance ? lookup(instance.moduleName) : undefined;
    if (!instance || !target || visited.has(target)) {
      blocks.push(withoutIndex(segment));
      continue;
    }
    visited.add(target);
    created = { parent: module, instance };
    module = target;
    blocks = [];
  }
  return created ? { module, instance: created, blocks } : { module, blocks };
}

/**
 * Declaration for a VCD leaf name; memory words (`register[3]`) resolve to their
 * array. `blocks` (from `resolveHierarchy`) prefers declarations local to those
 * named generate blocks, innermost first, over module-level ones.
 */
export function findDeclaration(module: VerilogModule, leafName: string, blocks: readonly string[] = []): VerilogDecl | undefined {
  const name = withoutIndex(leafName);
  for (const label of [...blocks].reverse()) {
    for (const block of module.generateBlocks) {
      const declaration = block.name === label ? block.declarations.find((candidate) => candidate.name === name) : undefined;
      if (declaration) {
        return declaration;
      }
    }
  }
  return module.declarations.get(name) ?? module.ports.find((port) => port.name === name);
}

function withoutIndex(segment: string): string {
  return segment.replace(/\[[^\]]*\]$/, '');
}

export interface MemoryDump {
  /** Hierarchical reference usable from another top module, e.g. `tb.uut.CPU.GRF.register`. */
  readonly path: string;
  readonly first: number;
  readonly last: number;
}

export interface MemorySearchLimits {
  /** Largest memory (in words) dumped element by element. */
  readonly maximumWords: number;
  readonly maximumInstances: number;
  readonly maximumMemories: number;
  readonly maximumDepth: number;
}

export const defaultMemorySearchLimits: MemorySearchLimits = {
  maximumWords: 64,
  maximumInstances: 512,
  maximumMemories: 32,
  maximumDepth: 16
};

const simpleIdentifier = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const memoryKinds = new Set(['reg', 'logic', 'wire', 'integer']);
const defparamPattern = /\bdefparam\b/;

/**
 * How far statically evaluated parameters can be trusted below an instance.
 * Once an override cannot be evaluated (macro, function) or a defparam may
 * retarget parameters, only memories with literal bounds are dumped.
 */
interface ParameterContext {
  readonly overrides: VerilogConstantOverrides | undefined;
  readonly trusted: boolean;
}

/**
 * Small one-dimensional memories below `root` (the testbench), e.g. a 32-word GRF.
 * `$dumpvars` without arguments never includes memories, so these need explicit
 * per-word dumps. Only paths and bounds known for certain are returned: escaped
 * identifiers, arrays local to tasks/functions and instances inside generate
 * blocks (whose scopes the model does not name) are skipped rather than risking a
 * compile error in the generated dumper.
 */
export function findDumpableMemories(
  root: VerilogModule,
  lookup: ModuleLookup,
  limits: MemorySearchLimits = defaultMemorySearchLimits
): MemoryDump[] {
  const memories: MemoryDump[] = [];
  if (!simpleIdentifier.test(root.name)) {
    return memories;
  }
  let instances = 0;
  const visit = (module: VerilogModule, path: string, depth: number, inherited: ParameterContext, ancestors: ReadonlySet<string>): void => {
    const context = inherited.trusted && defparamPattern.test(module.bodyText) ? { ...inherited, trusted: false } : inherited;
    const subroutines = [...module.declarations.values()].filter((declaration) => declaration.kind === 'task' || declaration.kind === 'function');
    for (const declaration of module.declarations.values()) {
      if (memories.length >= limits.maximumMemories) {
        return;
      }
      if (subroutines.some((subroutine) => subroutine !== declaration && containsRange(subroutine.range, declaration.range))) {
        continue;
      }
      const bounds = memoryBounds(declaration, context.trusted ? module : undefined, context.overrides);
      if (bounds && bounds.last - bounds.first + 1 <= limits.maximumWords && simpleIdentifier.test(declaration.name)) {
        memories.push({ path: `${path}.${declaration.name}`, ...bounds });
      }
    }
    if (depth >= limits.maximumDepth) {
      return;
    }
    for (const instance of module.instances) {
      if (instances >= limits.maximumInstances || memories.length >= limits.maximumMemories) {
        return;
      }
      const target = lookup(instance.moduleName);
      if (!target || instance.inGenerateBlock || ancestors.has(target.name) || !simpleIdentifier.test(instance.instanceName)) {
        continue;
      }
      instances++;
      const nextAncestors = new Set(ancestors).add(target.name);
      const resolved = resolveParameterOverrides(instance, module, target, context.overrides);
      const childContext = { overrides: resolved.overrides, trusted: context.trusted && resolved.unresolved.length === 0 };
      visit(target, `${path}.${instance.instanceName}`, depth + 1, childContext, nextAncestors);
    }
  };
  visit(root, root.name, 0, { overrides: undefined, trusted: true }, new Set([root.name]));
  return memories;
}

/** Array bounds; without `module` only literal bounds evaluate. */
function memoryBounds(
  declaration: VerilogDecl,
  module: VerilogModule | undefined,
  overrides: VerilogConstantOverrides | undefined
): { first: number; last: number } | undefined {
  const dimensions = declaration.unpackedDimensions;
  if (!dimensions || dimensions.length !== 1 || !memoryKinds.has(declaration.kind)) {
    return undefined;
  }
  const values = dimensions[0].expressions.map((expression) => evalExpressionAstConstant(expression, module, overrides));
  if (values.some((value) => value === undefined)) {
    return undefined;
  }
  const numbers = values.map((value) => Number(value));
  if (!numbers.every(Number.isSafeInteger)) {
    return undefined;
  }
  if (numbers.length === 1) {
    return numbers[0] > 0 ? { first: 0, last: numbers[0] - 1 } : undefined;
  }
  if (numbers.length === 2) {
    return { first: Math.min(numbers[0], numbers[1]), last: Math.max(numbers[0], numbers[1]) };
  }
  return undefined;
}
