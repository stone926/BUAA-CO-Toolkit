import { Range } from 'vscode-languageserver/node';
import type { MipsOperandAst } from './ast';

export interface MipsOperandReferenceCandidate {
  text: string;
  range: Range;
  operand?: MipsOperandAst;
}

export function visitMipsOperand(operand: MipsOperandAst, visitor: (operand: MipsOperandAst) => void): void {
  visitor(operand);
  if (operand.kind === 'memory') {
    visitMipsOperand(operand.offset, visitor);
    visitMipsOperand(operand.base, visitor);
  }
  if (operand.kind === 'expression' && operand.labelPlusImmediate) {
    visitMipsOperand(operand.labelPlusImmediate.label, visitor);
    visitMipsOperand(operand.labelPlusImmediate.immediate, visitor);
  }
}

export function collectMipsOperandReferences(operand: MipsOperandAst, options: { includeRegisters?: boolean } = {}): MipsOperandReferenceCandidate[] {
  const references: MipsOperandReferenceCandidate[] = [];
  visitMipsOperand(operand, (candidate) => {
    if (candidate.kind === 'symbol' || candidate.kind === 'macroParameter' || (options.includeRegisters && candidate.kind === 'register')) {
      references.push({
        text: candidate.text,
        range: candidate.range,
        operand: candidate
      });
      return;
    }
    if (candidate.kind === 'expression' && !candidate.labelPlusImmediate) {
      references.push(...symbolReferencesFromExpressionOperand(candidate));
    }
  });
  return references;
}

function symbolReferencesFromExpressionOperand(operand: MipsOperandAst): MipsOperandReferenceCandidate[] {
  const references: MipsOperandReferenceCandidate[] = [];
  const text = operand.text;
  let quote: string | undefined;
  let escaped = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === quote && !escaped) {
        quote = undefined;
        escaped = false;
      } else if (char === '\\') {
        escaped = !escaped;
      } else {
        escaped = false;
      }
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      escaped = false;
      index++;
      continue;
    }
    if (!isOperandReferenceStart(text, index)) {
      index++;
      continue;
    }
    const start = index;
    index++;
    while (index < text.length && isMipsSymbolPart(text[index])) {
      index++;
    }
    references.push({
      text: text.slice(start, index),
      range: Range.create(
        operand.range.start.line,
        operand.range.start.character + start,
        operand.range.start.line,
        operand.range.start.character + index
      ),
      operand
    });
  }
  return references;
}

function isOperandReferenceStart(text: string, index: number): boolean {
  const char = text[index];
  if ((char === '%' || char === '$') && isMipsSymbolStart(text[index + 1] ?? '')) {
    return true;
  }
  return char !== '$' && char !== '%' && isMipsSymbolStart(char);
}

function isMipsSymbolStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '.' || char === '$';
}

function isMipsSymbolPart(char: string): boolean {
  return isMipsSymbolStart(char) || (char >= '0' && char <= '9');
}
