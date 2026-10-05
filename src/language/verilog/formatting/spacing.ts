// @index formatting-spacing — 仅决定相邻 token 间的水平空白
import { verilogLanguageCatalog } from '../model';
import { Source } from './source';
import { Structure } from './structure';

const spacedParen = new Set(['if', 'for', 'while', 'repeat', 'wait', 'case', 'casex', 'casez']);
const binary = new Set(['=', '+', '-', '*', '/', '%', '**', '&', '|', '^', '^~', '~^', '&&', '||', '==', '!=', '===', '!==', '<', '>', '<=', '>=', '<<', '>>', '<<<', '>>>', '?', '+:', '-:']);
const compounds = [...new Set([...Object.values(verilogLanguageCatalog.operators).flat(), '//', '/*'])]
  .filter(operator => operator.length > 1);

export function horizontalSpace(source: Source, structure: Structure, i: number, original: string): string {
  const space = preferredSpace(source, structure, i, original);
  if (space || !original) return space;
  const left = source.tokens[i - 1]; const right = source.tokens[i];
  if (!left || !right) return space;
  const a = left.value; const b = right.value;
  // 删除间隙之前检查词法边界；只查看已有 token，不重复扫描源码。
  if (left.kind === 'number' && b === '.' || a === '.' && right.kind === 'number' && source.tokens[i - 2]?.kind === 'number') return ' ';
  if (/[\w$]$/.test(a) && /^[\w$]/.test(b)) return ' ';
  if (left.kind === 'operator' && compounds.some(operator => operator.length > a.length && (a + b).startsWith(operator))) return ' ';
  return space;
}

function preferredSpace(source: Source, structure: Structure, i: number, original: string): string {
  const left = source.tokens[i - 1]; const right = source.tokens[i];
  if (!left) return '';
  const a = left.value; const b = right.value;
  if (left.protected || right.protected || structure.preserve.has(i) || structure.preserve.has(i - 1)) return original;
  if (left.kind === 'identifier' && a.startsWith('\\')) return ' ';
  if (right.kind === 'comment' || left.kind === 'comment') return ' ';
  if (b === ':' && structure.rangeColon.has(i)) return '';
  if (a === ':' && structure.rangeColon.has(i - 1)) return '';
  if (b === ':' && structure.labelColon.has(i)) return '';
  if (a === ':' || b === ':') return ' ';
  if (structure.declarationRange.has(i) && b === '[' || structure.declarationRange.has(i - 1) && a === ']') {
    return ' ';
  }
  if (a === ',' && b === '.') return ' ';
  if (b === ',' || b === ';' || b === ')' || b === ']' || b === '}') return '';
  if (a === '(' || a === '[' || a === '{' || a === '.') return '';
  if (b === '.' || b === '[') return '';
  if (a === ',' || a === ';') return ' ';
  if (b === '(') {
    if (spacedParen.has(a)) return ' ';
    if (a === '@' || a === '#') return '';
    if (structure.list.has(i)) return ' ';
    if (a === '@' || a === '#' || structure.unary.has(i - 1)) return '';
    if (binary.has(a)) return ' ';
    return '';
  }
  if (a === '@' || a === '#') return '';
  if (b === '@' || b === '#') return ' ';
  if (structure.unary.has(i - 1)) {
    // 防止空白删除后合并成另一个复合操作符或注释起始符。
    return /[+\-~&|^!]$/.test(a) && /^[+\-~&|^!=]/.test(b) ? ' ' : '';
  }
  if (binary.has(a) || binary.has(b)) return ' ';
  if (b === '!' || b === '~') return ' ';
  return ' ';
}
