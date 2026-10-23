// @index verilog-module-resolution — unique context-bound module resolution for diagnostics and providers
import type { VerilogInstance, VerilogModule } from './model';

export interface ContextualModuleIndex {
  getModules(name: string, fromUri?: string): VerilogModule[];
}

export function resolveInstanceTargetModule(index: ContextualModuleIndex, modules: VerilogModule[], instance: VerilogInstance): VerilogModule | undefined {
  const uri = modules.find((module) => module.instances.includes(instance))?.uri ?? modules[0]?.uri;
  const candidates = index.getModules(instance.moduleName, uri);
  if (candidates.length) return uniqueModule(candidates);
  return uniqueModule(modules.filter((module) => module.name === instance.moduleName));
}

export function uniqueModule(modules: readonly VerilogModule[]): VerilogModule | undefined {
  return modules.length === 1 ? modules[0] : undefined;
}
