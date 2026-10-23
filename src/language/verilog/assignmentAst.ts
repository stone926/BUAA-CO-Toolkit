import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { VerilogAssignmentExpressionAst, VerilogModuleAst } from './ast';
import type { VerilogExpressionAst } from './exprAst';
import type { VerilogProceduralStatementAst } from './proceduralAst';

export function visitProceduralAssignments(statement: VerilogProceduralStatementAst, visit: (assignment: Extract<VerilogProceduralStatementAst, { kind: 'assignment' }>) => void): void {
  switch (statement.kind) {
    case 'assignment': visit(statement); return;
    case 'block': statement.statements.forEach((child) => visitProceduralAssignments(child, visit)); return;
    case 'if': visitProceduralAssignments(statement.consequent, visit); if (statement.alternate) { visitProceduralAssignments(statement.alternate, visit); } return;
    case 'case': statement.items.forEach((item) => visitProceduralAssignments(item.body, visit)); return;
    case 'loop':
    case 'wait': visitProceduralAssignments(statement.body, visit); return;
    default: return;
  }
}

export interface AssignmentUse {
  name: string;
  operator: '=' | '<=';
  range: Range;
  blockIndex: number;
  expression: VerilogExpressionAst;
  source: VerilogExpressionAst;
}

interface AssignmentAstTarget {
  name: string;
  range: Range;
  expression: VerilogExpressionAst;
}

export function collectAssignmentUsesFromModuleAst(document: TextDocument, moduleAst: VerilogModuleAst): AssignmentUse[] {
  return [
    ...collectContinuousAssignmentUsesFromAst(document, moduleAst),
    ...collectProceduralAssignmentUsesFromAst(document, moduleAst)
  ];
}

export function collectContinuousAssignmentUsesFromAst(document: TextDocument, moduleAst: VerilogModuleAst): AssignmentUse[] {
  const result: AssignmentUse[] = [];
  for (const statement of moduleAst.items) {
    if (statement.kind !== 'continuousAssign') {
      continue;
    }
    for (const assignment of statement.assignments) {
      result.push(...assignmentUsesFromAssignmentAst(document, assignment, -1));
    }
  }
  return result;
}

export function collectProceduralAssignmentUsesFromAst(document: TextDocument, moduleAst: VerilogModuleAst): AssignmentUse[] {
  const result: AssignmentUse[] = [];
  for (let index = 0; index < moduleAst.proceduralBlocks.length; index++) {
    result.push(...collectAssignmentUsesFromProceduralStatementAst(document, moduleAst.proceduralBlocks[index].statementTree, index));
  }
  return result;
}

export function collectAssignmentUsesFromProceduralStatementAst(
  document: TextDocument,
  statement: VerilogProceduralStatementAst,
  blockIndex: number
): AssignmentUse[] {
  switch (statement.kind) {
    case 'block':
      return statement.statements.flatMap((child) => collectAssignmentUsesFromProceduralStatementAst(document, child, blockIndex));
    case 'assignment':
      return statement.lhs
        ? assignmentUsesFromExpressionAst(document, statement.operator, statement.lhs, blockIndex)
        : [];
    case 'if':
      return [
        ...collectAssignmentUsesFromProceduralStatementAst(document, statement.consequent, blockIndex),
        ...(statement.alternate ? collectAssignmentUsesFromProceduralStatementAst(document, statement.alternate, blockIndex) : [])
      ];
    case 'case':
      return statement.items.flatMap((item) => collectAssignmentUsesFromProceduralStatementAst(document, item.body, blockIndex));
    case 'loop':
    case 'wait':
      return collectAssignmentUsesFromProceduralStatementAst(document, statement.body, blockIndex);
    case 'declaration':
    case 'other':
      return [];
  }
}

export function assignmentTargetsFromExpressionAst(document: TextDocument, expression: VerilogExpressionAst): AssignmentAstTarget[] {
  return targetIdentifiersFromExpression(expression).map((target) => ({
    name: target.name,
    expression: target.expression,
    range: Range.create(document.positionAt(target.start), document.positionAt(target.end))
  }));
}

function assignmentUsesFromAssignmentAst(
  document: TextDocument,
  assignment: VerilogAssignmentExpressionAst,
  blockIndex: number
): AssignmentUse[] {
  return assignmentUsesFromExpressionAst(document, assignment.operator, assignment.lhs, blockIndex);
}

function assignmentUsesFromExpressionAst(
  document: TextDocument,
  operator: '=' | '<=',
  lhs: VerilogExpressionAst,
  blockIndex: number
): AssignmentUse[] {
  return assignmentTargetsFromExpressionAst(document, lhs).map((target) => ({
    name: target.name,
    operator,
    range: target.range,
    blockIndex,
    expression: target.expression,
    source: lhs
  }));
}

function targetIdentifiersFromExpression(expression: VerilogExpressionAst): Array<{ name: string; start: number; end: number; expression: VerilogExpressionAst }> {
  switch (expression.kind) {
    case 'identifier':
      return [{ name: expression.name, start: expression.start, end: expression.end, expression }];
    case 'selectExpression':
      return targetIdentifiersFromExpression(expression.target).map((target) => ({ ...target, expression }));
    case 'concatenation':
      return expression.elements.flatMap(targetIdentifiersFromExpression);
    case 'parenthesizedExpression':
      return targetIdentifiersFromExpression(expression.expression);
    case 'memberExpression':
      // A hierarchical member is not a write to its instance-name prefix.
      // Cross-hierarchy accesses need elaborated identities before comparison.
      return [];
    default:
      return [];
  }
}
