import {
  Diagnostic,
  DiagnosticSeverity,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings, isVerilogLintRuleEnabled } from '../common/settings';
import { VerilogAlwaysBlockAst } from './blockAst';
import { evalExpressionAstConstant, widthOfExpressionAst } from './expressions';
import { VerilogExpressionAst } from './exprAst';
import { VerilogModule } from './model';
import { VerilogCaseStatementAst, VerilogProceduralStatementAst } from './proceduralAst';

interface FlowResult {
  definite: Set<string>;
  assigned: Set<string>;
  issues: DataflowIssue[];
}

interface DataflowIssue {
  range: Range;
  message: string;
  code: string;
}

export function collectCombinationalDataflowDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  module: VerilogModule,
  block: VerilogAlwaysBlockAst,
  diagnostics: Diagnostic[]
): void {
  if (!isVerilogLintRuleEnabled(settings, 'vc-008')) {
    return;
  }

  const result = analyzeFlow(block.statementTree, new Set(), module);
  const reported = new Set<string>();
  for (const issue of result.issues) {
    const key = `${issue.code}:${issue.range.start.line}:${issue.range.start.character}`;
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    diagnostics.push(makeDiagnostic(issue.range, issue.message, DiagnosticSeverity.Information, issue.code));
  }
  for (const name of [...result.assigned].sort()) {
    if (result.definite.has(name)) {
      continue;
    }
    const decl = module.declarations.get(name);
    diagnostics.push(makeDiagnostic(
      decl?.selectionRange ?? block.headerRange,
      `VC-008: combinational signal '${name}' is not assigned on every control-flow path.`,
      DiagnosticSeverity.Information,
      'vc-008-comb-incomplete-assignment'
    ));
  }
}

function analyzeFlow(node: VerilogProceduralStatementAst, before: Set<string>, module: VerilogModule): FlowResult {
  switch (node.kind) {
    case 'block':
      return analyzeBlock(node, before, module);
    case 'assignment':
      return {
        definite: union(before, new Set(node.targets)),
        assigned: new Set(node.targets),
        issues: []
      };
    case 'if':
      return analyzeIf(node, before, module);
    case 'case':
      return analyzeCase(node, before, module);
    case 'loop': {
      const body = analyzeFlow(node.body, new Set(before), module);
      return {
        definite: new Set(before),
        assigned: body.assigned,
        issues: body.issues
      };
    }
    case 'other':
    case 'declaration':
      return {
        definite: new Set(before),
        assigned: new Set(),
        issues: []
      };
  }
}

function analyzeBlock(node: Extract<VerilogProceduralStatementAst, { kind: 'block' }>, before: Set<string>, module: VerilogModule): FlowResult {
  let definite = new Set(before);
  const assigned = new Set<string>();
  const issues: DataflowIssue[] = [];
  for (const statement of node.statements) {
    const result = analyzeFlow(statement, definite, module);
    definite = result.definite;
    addAll(assigned, result.assigned);
    issues.push(...result.issues);
  }
  return {
    definite,
    assigned,
    issues
  };
}

function analyzeIf(node: Extract<VerilogProceduralStatementAst, { kind: 'if' }>, before: Set<string>, module: VerilogModule): FlowResult {
  const consequent = analyzeFlow(node.consequent, new Set(before), module);
  const assigned = new Set(consequent.assigned);
  const issues = [...consequent.issues];
  if (!node.alternate) {
    if ([...consequent.assigned].some((name) => !before.has(name))) {
      issues.push({
        range: node.range,
        message: 'VC-008: combinational if statements should cover the false branch or assign defaults before the if.',
        code: 'vc-008-comb-branch'
      });
    }
    return {
      definite: new Set(before),
      assigned,
      issues
    };
  }

  const alternate = analyzeFlow(node.alternate, new Set(before), module);
  addAll(assigned, alternate.assigned);
  issues.push(...alternate.issues);
  return {
    definite: intersection(consequent.definite, alternate.definite),
    assigned,
    issues
  };
}

function analyzeCase(node: VerilogCaseStatementAst, before: Set<string>, module: VerilogModule): FlowResult {
  const itemResults = node.items.map((item) => analyzeFlow(item.body, new Set(before), module));
  const assigned = new Set<string>();
  const issues: DataflowIssue[] = [];
  for (const result of itemResults) {
    addAll(assigned, result.assigned);
    issues.push(...result.issues);
  }
  if (!itemResults.length) {
    return {
      definite: new Set(before),
      assigned,
      issues
    };
  }

  const covered = caseCoversEveryValue(node, module);
  if (!covered && [...assigned].some((name) => !before.has(name))) {
    issues.push({
      range: node.range,
      message: 'VC-008: combinational case statements should include default or cover every value.',
      code: 'vc-008-case-default'
    });
  }

  const paths = covered
    ? itemResults.map((result) => result.definite)
    : [...itemResults.map((result) => result.definite), before];
  return {
    definite: intersectMany(paths),
    assigned,
    issues
  };
}

function caseCoversEveryValue(node: VerilogCaseStatementAst, module: VerilogModule): boolean {
  if (node.items.some((item) => item.defaultItem)) {
    return true;
  }
  if (node.caseKind !== 'case' || !node.expression) {
    return false;
  }
  const width = widthOfExpressionAst(node.expression, module).width;
  if (width === undefined || width < 1 || width > 8) {
    return false;
  }
  const values = new Set<bigint>();
  for (const item of node.items) {
    for (const label of item.labels) {
      const value = evalExpressionAstConstant(label, module);
      if (value !== undefined) {
        values.add(value);
      }
    }
  }
  return values.size >= 2 ** width;
}

function union<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set(left);
  addAll(result, right);
  return result;
}

function intersection<T>(left: Set<T>, right: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of left) {
    if (right.has(item)) {
      result.add(item);
    }
  }
  return result;
}

function intersectMany<T>(sets: Set<T>[]): Set<T> {
  if (!sets.length) {
    return new Set();
  }
  return sets.slice(1).reduce((acc, item) => intersection(acc, item), new Set(sets[0]));
}

function addAll<T>(target: Set<T>, source: Set<T>): void {
  for (const item of source) {
    target.add(item);
  }
}
