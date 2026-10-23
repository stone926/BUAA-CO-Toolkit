// @index declaration-diagnostics — Original declaration identities and lexical namespace conflicts
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsPosition, containsRange, makeDiagnostic, rangesEqual } from '../common/lsp';
import { rangeKey } from '../common/util';
import type { VerilogAstDocument } from './ast';
import { declarationIsVariable } from './accessPaths';
import { evalExpressionAstConstant } from './expressions';
import { exclusiveGenerateBranches } from './generateScopes';
import { hasUnexpandedDeclarationDependencies } from './declarationDependencies';
import type { VerilogDecl, VerilogModule } from './model';
import type { VerilogProceduralStatementAst } from './proceduralAst';
import type { VerilogSemanticModel, VerilogSemanticScope } from './semanticModel';

interface DeclarationRecord {
  namedBlock?: boolean;
  name: string;
  range: Range;
  declaration?: VerilogDecl;
  scope: VerilogSemanticScope;
  /** Old-style directions permit one compatible, separate storage declaration. */
  supplementary: boolean;
  functionReturn?: boolean;
}

export function collectDeclarationDiagnostics(document: TextDocument, ast: VerilogAstDocument, semantic: VerilogSemanticModel, diagnostics: Diagnostic[]): void {
  for (const moduleAst of ast.modules) {
    const module = moduleAst.module;
    const root = semantic.moduleScopes.find((scope) => scope.module === module);
    if (!root) continue;
    const scopes = semantic.blockScopes.filter((scope) => scope.module === module);
    const scopeFor = (range: Range, parent = false): VerilogSemanticScope => {
      let best = root;
      for (const scope of scopes) {
        if (parent && (rangesEqual(scope.range, range) || !containsRange(scope.range, range))) continue;
        if (containsPosition(scope.range, range.start) && (best === root || containsRange(best.range, scope.range))) best = scope;
      }
      return best;
    };
    const records: DeclarationRecord[] = [];
    const seen = new Set<string>();
    const add = (decl: VerilogDecl, scope: VerilogSemanticScope, supplementary = false): void => {
      if (decl.implicitGenerateParameter) return;
      const key = `${decl.name}:${rangeKey(decl.selectionRange)}`;
      if (seen.has(key)) return;
      seen.add(key);
      records.push({ name: decl.name, range: decl.selectionRange, declaration: decl, scope, supplementary });
    };
    const original = module.declarationRecords ?? [...module.declarations.values()];
    for (const decl of original) {
      const oldStyle = !!decl.direction && document.offsetAt(decl.selectionRange.start) >= document.offsetAt(module.headerEnd);
      add(decl, root, oldStyle);
    }
    for (const signature of module.subroutines ?? []) {
      add(signature.declaration, semantic.symbols.find((symbol) => symbol.decl === signature.declaration)?.scope ?? scopeFor(signature.range, true));
      if (signature.kind === 'function') {
        const ownScope = scopes.find((scope) => scope.name === 'function' && rangesEqual(scope.range, signature.range));
        if (ownScope) records.push({ name: signature.name, range: signature.declaration.selectionRange, declaration: signature.declaration, scope: ownScope, supplementary: false, functionReturn: true });
      }
      for (const decl of signature.declarations) add(decl, scopeFor(decl.selectionRange), !signature.ansi && !!decl.direction);
    }
    for (const scope of module.lexicalScopes ?? []) for (const decl of scope.declarations) add(decl, scopeFor(decl.selectionRange));
    for (const block of module.generateBlocks) {
      for (const decl of block.declarations) add(decl, scopeFor(decl.selectionRange));
      if (block.name && block.selectionRange) records.push({ name: block.name, range: block.selectionRange, scope: scopeFor(block.range, true), supplementary: false, namedBlock: true });
    }
    for (const instance of module.instances) records.push({ name: instance.instanceName, range: instance.selectionRange, scope: scopeFor(instance.selectionRange), supplementary: false });
    const visitBlockNames = (statement: VerilogProceduralStatementAst): void => {
      switch (statement.kind) {
        case 'block': {
          if (statement.label) {
            const token = statement.tokens.find((item, index) => item.value === statement.label && statement.tokens[index - 1]?.value === ':');
            if (token) records.push({ name: statement.label, range: Range.create(document.positionAt(token.start), document.positionAt(token.end)), scope: scopeFor(statement.range, true), supplementary: false, namedBlock: true });
          }
          statement.statements.forEach(visitBlockNames); return;
        }
        case 'if': visitBlockNames(statement.consequent); if (statement.alternate) visitBlockNames(statement.alternate); return;
        case 'case': statement.items.forEach((item) => visitBlockNames(item.body)); return;
        case 'loop':
        case 'wait': visitBlockNames(statement.body); return;
        default: return;
      }
    };
    [...moduleAst.proceduralBlocks, ...moduleAst.subroutines].forEach((block) => visitBlockNames(block.statementTree));
    records.sort((left, right) => document.offsetAt(left.range.start) - document.offsetAt(right.range.start));
    const byScope = new Map<VerilogSemanticScope, Map<string, DeclarationRecord[]>>();
    for (const record of records) {
      const scopeNames = byScope.get(record.scope) ?? new Map<string, DeclarationRecord[]>();
      byScope.set(record.scope, scopeNames);
      const previous = scopeNames.get(record.name) ?? [];
      const conflict = previous.find((earlier) => !exclusiveGenerateBranches(module, earlier.range.start, record.range.start) && !compatibleDeclarations(earlier, record, module));
      if (conflict) {
        const directionsConflict = record.declaration?.direction && conflict.declaration?.direction && record.declaration.direction !== conflict.declaration.direction;
        diagnostics.push(makeDiagnostic(record.range, directionsConflict ? `Port '${record.name}' has conflicting directions.` : `Duplicate or conflicting declaration of '${record.name}' in the same scope.`, DiagnosticSeverity.Error, directionsConflict ? 'conflicting-port-direction' : 'duplicate-declaration'));
      }
      previous.push(record);
      scopeNames.set(record.name, previous);
    }
    if (module.hasEndmodule && module.hasCompleteHeader !== false && !hasUnexpandedDeclarationDependencies(ast, moduleAst)) {
      for (const port of original.filter((decl) => decl.headerPlaceholder)) {
        if (!original.some((decl) => decl.name === port.name && !!decl.direction)) diagnostics.push(makeDiagnostic(port.selectionRange, `Port '${port.name}' in the module header has no input, output, or inout declaration.`, DiagnosticSeverity.Error, 'missing-port-direction'));
      }
    }
  }
}

function compatibleDeclarations(left: DeclarationRecord, right: DeclarationRecord, module: VerilogModule): boolean {
  if ((left.functionReturn && right.namedBlock) || (right.functionReturn && left.namedBlock)) return true;
  const first = left.declaration, second = right.declaration;
  if (!first || !second) return false;
  if (left.functionReturn || right.functionReturn) {
    const redeclaration = left.functionReturn ? second : first;
    return !redeclaration.direction && declarationIsVariable(redeclaration);
  }
  if (first.headerPlaceholder || second.headerPlaceholder) return !(first.headerPlaceholder && second.headerPlaceholder);
  if (!!first.direction === !!second.direction) return false;
  const portRecord = first.direction ? left : right;
  const storage = first.direction ? second : first;
  const port = portRecord.declaration!;
  if (!portRecord.supplementary || port.explicitPortNetType !== false) return false;
  if (storage.kind === 'parameter' || storage.kind === 'localparam' || storage.kind === 'task' || storage.kind === 'function' || storage.kind === 'genvar') return false;
  if (!compatiblePackedRanges(port, storage, module)) return false;
  if (port.storage === 'variable') return declarationIsVariable(storage);
  return port.direction === 'output' || !declarationIsVariable(storage);
}

/** A scalar declaration differs from any explicit range, including [0:0]. */
function compatiblePackedRanges(port: VerilogDecl, storage: VerilogDecl, module: VerilogModule): boolean {
  if (!!port.width !== !!storage.width) return false;
  if (port.widthAst?.length !== 2 || storage.widthAst?.length !== 2) return true;
  for (let index = 0; index < 2; index++) {
    const left = evalExpressionAstConstant(port.widthAst[index], module, undefined, port.selectionRange.start);
    const right = evalExpressionAstConstant(storage.widthAst[index], module, undefined, storage.selectionRange.start);
    if (left !== undefined && right !== undefined && left !== right) return false;
  }
  return true;
}
