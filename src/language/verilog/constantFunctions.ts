// @index constant-functions — derive constant-function legality from bound references
import { containsRange } from '../common/lsp';
import type { VerilogModuleAst } from './ast';
import type { VerilogDecl } from './model';
import type { VerilogSemanticReference } from './semanticModel';

const constantSystemFunctions = new Set(['$signed', '$unsigned', '$clog2']);

/** This establishes legality only; a constant function may still have no folded numeric value. */
export function annotateConstantFunctions(modules: VerilogModuleAst[], references: VerilogSemanticReference[]): void {
  const dependencies = new Map<VerilogDecl, Set<VerilogDecl>>();
  for (const moduleAst of modules) {
    for (const subroutine of moduleAst.subroutines) {
      if (subroutine.subroutineKind !== 'function' || !subroutine.name) continue;
      const decl = moduleAst.module.declarations.get(subroutine.name);
      if (!decl || decl.kind !== 'function') continue;
      const calls = new Set<VerilogDecl>();
      dependencies.set(decl, calls);
      decl.constantFunction = !subroutine.tokens.some((token) =>
        ['#', '@', 'wait', 'output', 'inout'].includes(token.value) ||
        (token.kind === 'systemIdentifier' && !constantSystemFunctions.has(token.value)));
      for (const reference of references) {
        if (!containsRange(subroutine.bodyRange, reference.range) || reference.kind === 'macro') continue;
        const target = reference.symbol?.decl;
        if (!target) { decl.constantFunction = false; continue; }
        if (target.kind === 'function') { calls.add(target); continue; }
        if (target.kind === 'parameter' || target.kind === 'localparam') continue;
        if (target.kind === 'task' || !containsRange(subroutine.range, target.selectionRange)) decl.constantFunction = false;
      }
    }
  }
  // Propagate forbidden captures through function calls without executing their bodies.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [decl, calls] of dependencies) {
      if (decl.constantFunction && [...calls].some((target) => target.constantFunction === false)) {
        decl.constantFunction = false;
        changed = true;
      }
    }
  }
}
