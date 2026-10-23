// @index constant-functions — derive constant-function legality from bound references
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { containsRange } from '../common/lsp';
import type { VerilogModuleAst } from './ast';
import type { VerilogDecl } from './model';
import type { VerilogSemanticReference } from './semanticModel';
import { classifySystemFunctionConstant } from './systemFunctionConstants';
import { constantFunctionReadDependencies } from './constantFunctionCaptures';

/** This establishes legality only; a constant function may still have no folded numeric value. */
export function annotateConstantFunctions(document: TextDocument, modules: VerilogModuleAst[], references: VerilogSemanticReference[]): void {
  const dependencies = new Map<VerilogDecl, Set<VerilogDecl>>();
  for (const moduleAst of modules) {
    for (const subroutine of moduleAst.subroutines) {
      if (subroutine.subroutineKind !== 'function' || !subroutine.name) continue;
      const decl = subroutine.signature?.declaration ?? moduleAst.module.declarations.get(subroutine.name);
      if (!decl || decl.kind !== 'function') continue;
      const calls = new Set<VerilogDecl>();
      dependencies.set(decl, calls);
      decl.constantFunction = !subroutine.tokens.some((token) => ['#', '@', 'wait', 'output', 'inout'].includes(token.value));
      for (const token of subroutine.tokens) {
        if (token.kind !== 'systemIdentifier') continue;
        const classification = classifySystemFunctionConstant(token.value);
        if (classification === 'nonConstant') decl.constantFunction = false;
        else if (classification === 'unknown' && decl.constantFunction !== false) decl.constantFunction = undefined;
      }
      for (const reference of references) {
        if (!containsRange(subroutine.bodyRange, reference.range) || reference.kind === 'macro') continue;
        const target = reference.symbol?.decl;
        if (!target) { if (decl.constantFunction !== false) decl.constantFunction = undefined; continue; }
        if (target.kind === 'function') { if (reference.callable) calls.add(target); continue; }
        if (target.kind === 'parameter' || target.kind === 'localparam') continue;
        if (target.kind === 'task' || !containsRange(subroutine.range, target.selectionRange)) decl.constantFunction = false;
      }
      decl.constantFunctionDependencies = constantFunctionReadDependencies(document, moduleAst.module, subroutine, references);
    }
  }
  // Propagate forbidden captures through function calls without executing their bodies.
  let changed = true;
  while (changed) {
    changed = false;
    for (const [decl, calls] of dependencies) {
      if (decl.constantFunction !== false && [...calls].some((target) => target.constantFunction === false)) {
        decl.constantFunction = false;
        changed = true;
      } else if (decl.constantFunction === true && [...calls].some((target) => target.constantFunction === undefined)) {
        decl.constantFunction = undefined;
        changed = true;
      }
    }
  }
}
