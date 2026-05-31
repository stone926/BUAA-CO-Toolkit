import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangeAtOffset } from '../common/lsp';
import { verilogKeywords } from './model';
import {
  isInsideForControl,
  splitSemicolonStatementSpans,
  splitTopLevelCommaSpans,
  stripCommentsAndStrings,
  TextSpan
} from './textUtils';

export interface AssignmentUse {
  name: string;
  operator: '=' | '<=';
  range: Range;
  blockIndex: number;
}

interface AssignmentTarget {
  name: string;
  start: number;
  end: number;
}

interface AssignmentOperatorInfo {
  operator: '=' | '<=';
  offset: number;
}

export function collectAssignmentsInText(document: TextDocument, text: string, offset: number, blockIndex: number): AssignmentUse[] {
  const assignments: AssignmentUse[] = [];
  const stripped = stripCommentsAndStrings(text);
  for (const statement of splitSemicolonStatementSpans(stripped)) {
    const operator = findStatementAssignmentOperator(statement.text);
    if (!operator) {
      continue;
    }
    const operatorOffset = statement.start + operator.offset;
    if (isInsideForControl(stripped, operatorOffset)) {
      continue;
    }
    const lhs = statement.text.slice(0, operator.offset);
    if (isDeclarationAssignmentPrefix(lhs)) {
      continue;
    }
    for (const target of assignmentTargetsFromLeftHandSide(lhs)) {
      assignments.push({
        name: target.name,
        operator: operator.operator,
        range: rangeAtOffset(document, offset + statement.start + target.start, target.end - target.start),
        blockIndex
      });
    }
  }
  return assignments;
}

function findStatementAssignmentOperator(statement: string): AssignmentOperatorInfo | undefined {
  let depth = 0;
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    if (char === '(' || char === '[' || char === '{') {
      depth++;
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (statement.startsWith('<=', index)) {
      return { operator: '<=', offset: index };
    }
    if (char === '=') {
      const previous = statement[index - 1] ?? '';
      const next = statement[index + 1] ?? '';
      if (previous !== '<' && previous !== '>' && previous !== '!' && previous !== '=' && next !== '=' && next !== '>') {
        return { operator: '=', offset: index };
      }
    }
  }
  return undefined;
}

function isDeclarationAssignmentPrefix(lhs: string): boolean {
  const prefix = lhs
    .replace(/[\s\S]*\b(?:begin|fork|else)\b/, '')
    .replace(/^\s*:\s*[A-Za-z_]\w*\s*/, '')
    .replace(/^\s*[A-Za-z_]\w*\s*:\s*/, '')
    .trimStart();
  return /^(?:(?:automatic|signed|unsigned)\s+)*(?:input|output|inout|wire|reg|logic|integer|real|realtime|time|parameter|localparam|genvar)\b/.test(prefix);
}

function assignmentTargetsFromLeftHandSide(lhs: string): AssignmentTarget[] {
  const trimmedEnd = lhs.trimEnd().length;
  const beforeOperator = lhs.slice(0, trimmedEnd);
  const concat = trailingConcatenation(beforeOperator);
  if (concat) {
    const targets: AssignmentTarget[] = [];
    for (const part of splitTopLevelCommaSpans(concat.text.slice(1, -1))) {
      const nestedTargets = assignmentTargetsFromLeftHandSide(part.text);
      for (const target of nestedTargets) {
        targets.push({
          ...target,
          start: concat.start + 1 + part.start + target.start,
          end: concat.start + 1 + part.start + target.end
        });
      }
    }
    return targets;
  }

  const match = /([A-Za-z_]\w*)\s*(?:\[[^\]]+\]\s*)?$/.exec(beforeOperator);
  if (!match) {
    return [];
  }
  const name = match[1];
  if (verilogKeywords.has(name)) {
    return [];
  }
  const start = match.index + match[0].indexOf(name);
  return [{ name, start, end: start + name.length }];
}

function trailingConcatenation(text: string): TextSpan | undefined {
  const end = text.trimEnd().length;
  if (end === 0 || text[end - 1] !== '}') {
    return undefined;
  }
  let depth = 0;
  for (let index = end - 1; index >= 0; index--) {
    const char = text[index];
    if (char === '}') {
      depth++;
      continue;
    }
    if (char === '{') {
      depth--;
      if (depth === 0) {
        return { text: text.slice(index, end), start: index, end };
      }
    }
  }
  return undefined;
}
