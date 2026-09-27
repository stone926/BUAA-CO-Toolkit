import {
  CodeAction,
  CodeActionKind,
  Position,
  Range,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultCoSettings } from '../common/settings';
import { getCachedVerilogParse } from './parseCache';

export interface NumericLiteralInfo {
  range: Range;
  size?: number;
  signed?: boolean;
  base: 'b' | 'o' | 'd' | 'h';
  value: bigint;
}

export function getVerilogLiteralCodeActions(document: TextDocument, range: Range): CodeAction[] {
  const literal = numericLiteralAt(document, range.start);
  if (!literal) {
    return [];
  }
  const bases: Array<{ base: NumericLiteralInfo['base']; title: string }> = [
    { base: 'b', title: 'Convert literal to binary' },
    { base: 'o', title: 'Convert literal to octal' },
    { base: 'd', title: 'Convert literal to decimal' },
    { base: 'h', title: 'Convert literal to hexadecimal' }
  ];
  return bases.map((item) => ({
    title: item.title,
    kind: CodeActionKind.RefactorRewrite,
    edit: {
      changes: {
        [document.uri]: [TextEdit.replace(literal.range, formatNumericLiteral(literal, item.base))]
      }
    }
  }));
}

export function formatNumericLiteralHover(literal: NumericLiteralInfo): string {
  const value = literal.value;
  const lines: string[] = [];
  const sizeLabel = literal.size !== undefined ? `${literal.size}'${literal.base}` : 'decimal';

  lines.push(`**Number** \`${sizeLabel}\``);
  lines.push('');

  const dec = value.toString(10);
  lines.push(`Decimal: \`${dec}\` · Hex: \`0x${value.toString(16).toUpperCase()}\``);

  const bin = value.toString(2);
  const grouped = bin.padStart(Math.ceil(bin.length / 4) * 4, '0')
    .replace(/(.{4})/g, '$1_').replace(/_$/, '');
  lines.push('', `Binary: \`${grouped.length > 80 ? `${grouped.slice(0, 77)}…` : grouped}\``);

  return lines.join('\n');
}

export function numericLiteralAt(document: TextDocument, position: Position): NumericLiteralInfo | undefined {
  const offset = document.offsetAt(position);
  const token = getCachedVerilogParse(document, defaultCoSettings, false).ast.tokens
    .find((item) => item.kind === 'number' && item.start <= offset && offset < item.end);
  return token ? parseNumericLiteral(token.value, Range.create(document.positionAt(token.start), document.positionAt(token.end))) : undefined;
}

function parseNumericLiteral(text: string, range: Range): NumericLiteralInfo | undefined {
  text = text.replace(/\s+/g, '').replace(/_/g, '');
  const based = text.match(/^(\d*)'[sS]?([bBoOdDhH])([0-9a-fA-F_xXzZ?]+)$/);
  if (based) {
    const digits = based[3].replace(/_/g, '');
    if (/[xXzZ?]/.test(digits)) {
      return undefined;
    }
    const base = based[2].toLowerCase() as NumericLiteralInfo['base'];
    const radix = base === 'b' ? 2 : base === 'o' ? 8 : base === 'd' ? 10 : 16;
    if (!digitsValidForRadix(digits, radix)) {
      return undefined;
    }
    return {
      range,
      size: based[1] ? Number(based[1]) : undefined,
      signed: /'[sS]/.test(text),
      base,
      value: parseDigitsToBigInt(digits, radix)
    };
  }
  if (/^\d+$/.test(text)) {
    return {
      range,
      base: 'd',
      value: BigInt(text)
    };
  }
  return undefined;
}

function formatNumericLiteral(literal: NumericLiteralInfo, base: NumericLiteralInfo['base']): string {
  const valueText = literal.value.toString(base === 'b' ? 2 : base === 'o' ? 8 : base === 'd' ? 10 : 16).toUpperCase();
  if (base === 'd' && literal.size === undefined && literal.signed === undefined) {
    return valueText;
  }
  const size = literal.size !== undefined ? String(literal.size) : '';
  return `${size}'${literal.signed ? 's' : ''}${base}${valueText}`;
}

function parseDigitsToBigInt(digits: string, radix: number): bigint {
  let value = 0n;
  const base = BigInt(radix);
  for (const char of digits.toLowerCase()) {
    const digit = BigInt(parseInt(char, radix));
    value = value * base + digit;
  }
  return value;
}

function digitsValidForRadix(digits: string, radix: number): boolean {
  return [...digits].every((char) => {
    const digit = parseInt(char, radix);
    return Number.isInteger(digit) && digit >= 0 && digit < radix;
  });
}
