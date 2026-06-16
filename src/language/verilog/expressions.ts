import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseVerilogCst } from './cst';
import { isIdentifierLike, VerilogToken } from './lexer';
import { VerilogDecl, VerilogModule } from './model';

export interface WidthInfo {
  width?: number;
  minWidth?: number;
  flexible?: boolean;
}

export function widthOfDecl(decl: VerilogDecl): WidthInfo {
  const rangeWidth = widthFromRange(decl.width);
  if (rangeWidth !== undefined) {
    return { width: rangeWidth };
  }
  if (decl.inferredWidth !== undefined) {
    const inferred: WidthInfo = { width: decl.inferredWidth };
    if (decl.inferredMinWidth !== undefined) {
      inferred.minWidth = decl.inferredMinWidth;
    }
    if (decl.inferredFlexible !== undefined) {
      inferred.flexible = decl.inferredFlexible;
    }
    return inferred;
  }
  if (decl.kind === 'integer' || decl.kind === 'time') {
    return { width: 32 };
  }
  return { width: 1 };
}

export function widthOfExpression(expression: string, module: VerilogModule): WidthInfo {
  return widthOfExpressionTokens(expressionTokens(expression), module);
}

export function widthOfConstantInitializer(expression: string): WidthInfo {
  return widthOfExpressionTokens(expressionTokens(expression), undefined);
}

export function shouldReportWidthMismatch(expected: WidthInfo, actual: WidthInfo): boolean {
  if (!expected.width || !actual.width) {
    return false;
  }
  // Only flag truncation — the value's minimal meaningful width exceeds the target, so bits are
  // lost. Assigning a narrower value to a wider target is normal zero/sign-extension and must not
  // warn. For "flexible" results (unsized literals, arithmetic/shift) the minimal width is used.
  const actualMinimum = actual.flexible ? (actual.minWidth ?? actual.width) : actual.width;
  return actualMinimum > expected.width;
}

function widthFromRange(width?: string): number | undefined {
  if (!width) {
    return undefined;
  }
  const tokens = expressionTokens(width);
  if (tokens.length !== 5 || tokens[0].value !== '[' || tokens[2].value !== ':' || tokens[4].value !== ']') {
    return undefined;
  }
  const left = decimalNumber(tokens[1]);
  const right = decimalNumber(tokens[3]);
  return left === undefined || right === undefined ? undefined : Math.abs(left - right) + 1;
}

function expressionTokens(expression: string): VerilogToken[] {
  const document = TextDocument.create('expr://verilog', 'verilog', 0, expression);
  return parseVerilogCst(document, expression).codeTokens.filter((token) => token.kind !== 'eof');
}

function widthOfExpressionTokens(rawTokens: VerilogToken[], module: VerilogModule | undefined): WidthInfo {
  let tokens = trimOuterParens(trimTokens(rawTokens));
  if (!tokens.length) {
    return {};
  }

  const ternary = splitTopLevelTernary(tokens);
  if (ternary) {
    return maxWidth(widthOfExpressionTokens(ternary.whenTrue, module), widthOfExpressionTokens(ternary.whenFalse, module));
  }

  if (tokens[0]?.value === '{' && tokens[tokens.length - 1]?.value === '}' && findMatchingForward(tokens, 0, '{', '}') === tokens.length - 1) {
    return widthOfConcatenation(tokens.slice(1, -1), module);
  }

  const shifted = splitTopLevelOperatorTokens(tokens, new Set(['<<<', '>>>', '<<', '>>']));
  if (shifted) {
    return flexibleWidth(widthOfExpressionTokens(shifted.left, module));
  }

  const comparison = splitTopLevelOperatorTokens(tokens, new Set(['===', '!==', '==', '!=', '<=', '>=', '<', '>', '&&', '||']));
  if (comparison) {
    return { width: 1 };
  }

  const binary = splitTopLevelOperatorTokens(tokens, new Set(['+', '-', '^', '|', '&', '~^', '^~', '**', '*', '/', '%']));
  if (binary) {
    return binaryOperatorWidth(
      widthOfExpressionTokens(binary.left, module),
      widthOfExpressionTokens(binary.right, module)
    );
  }

  if (isUnaryOperator(tokens[0]?.value)) {
    const operand = widthOfExpressionTokens(tokens.slice(1), module);
    // IEEE 5.4.1 Table 5-22: ~, +, - 保留操作数位宽；其余一元归约运算结果 1 位
    if (tokens[0].value === '~' || tokens[0].value === '+' || tokens[0].value === '-') {
      return operand;
    }
    return { width: 1 };
  }

  const selectWidth = widthOfPartSelect(tokens);
  if (selectWidth !== undefined) {
    return { width: selectWidth };
  }

  if (tokens.length === 1 && tokens[0].kind === 'number') {
    return literalWidth(tokens[0]);
  }

  if (tokens.length === 1 && isIdentifierLike(tokens[0].kind) && module) {
    const decl = module.declarations.get(tokens[0].value);
    return decl ? widthOfDecl(decl) : {};
  }

  // $signed(expr) / $unsigned(expr) — 宽度透传，仅改变符号性
  if (tokens[0]?.kind === 'systemIdentifier' && passThroughSystemFunction(tokens[0].value) && tokens[1]?.value === '(' && tokens[tokens.length - 1]?.value === ')' && findMatchingForward(tokens, 1, '(', ')') === tokens.length - 1) {
    return widthOfExpressionTokens(tokens.slice(2, -1), module);
  }

  return {};
}

function widthOfConcatenation(tokens: VerilogToken[], module: VerilogModule | undefined): WidthInfo {
  const repeat = repeatConcatenation(tokens);
  if (repeat) {
    const repeated = widthOfExpressionTokens(repeat.tokens, module).width;
    return repeated !== undefined ? { width: repeat.count * repeated } : {};
  }
  let width = 0;
  for (const part of splitTopLevel(tokens, ',')) {
    const partWidth = widthOfExpressionTokens(part, module).width;
    if (partWidth === undefined) {
      return {};
    }
    width += partWidth;
  }
  return { width };
}

function repeatConcatenation(tokens: VerilogToken[]): { count: number; tokens: VerilogToken[] } | undefined {
  if (tokens.length < 4 || tokens[0].kind !== 'number' || tokens[1].value !== '{' || tokens[tokens.length - 1].value !== '}') {
    return undefined;
  }
  const count = decimalNumber(tokens[0]);
  if (count === undefined || findMatchingForward(tokens, 1, '{', '}') !== tokens.length - 1) {
    return undefined;
  }
  return { count, tokens: tokens.slice(2, -1) };
}

function literalWidth(token: VerilogToken): WidthInfo {
  const parsed = parseNumberToken(token.value);
  if (parsed?.kind === 'based') {
    if (parsed.size !== undefined) {
      return { width: parsed.size };
    }
    // 无尺寸 based 常量：IEEE 规定 ≥32 位自决。不标记 flexible（严格模式），
    // 但保留 minWidth 供算术表达式中的 flexible 计算使用。
    const digits = parsed.digits.split('_').join('');
    const base = parsed.base.toLowerCase();
    const bitsPerDigit = base === 'b' ? 1 : base === 'o' ? 3 : base === 'h' ? 4 : undefined;
    const minWidth = bitsPerDigit ? Math.max(1, digits.length * bitsPerDigit) : minimalBitsForDecimal(digits);
    return { width: Math.max(32, minWidth), minWidth };
  }
  if (parsed?.kind === 'decimal') {
    // 无尺寸十进制常量同理：宽度 ≥32，不灵活。
    const minWidth = minimalBitsForDecimal(parsed.digits);
    return { width: Math.max(32, minWidth), minWidth };
  }
  return {};
}

function widthOfPartSelect(tokens: VerilogToken[]): number | undefined {
  if (tokens.length < 4 || tokens.length > 7) {
    return undefined;
  }
  if (!isIdentifierLike(tokens[0].kind) || tokens[1].value !== '[' || tokens[tokens.length - 1].value !== ']') {
    return undefined;
  }
  // Bit select: a[3]
  if (tokens.length === 4) {
    return decimalNumber(tokens[2]) !== undefined ? 1 : undefined;
  }
  // Find the separator and right operand index.
  // Compact indexed part-select: a[3+:4] (6 tokens, sep at [3])
  // Spaced indexed part-select:  a[3 +: 4] (7 tokens, + at [3], : at [4])
  // Traditional range:          a[7:0] (tokens vary, : at some index)
  if (tokens[3].value === '+:' || tokens[3].value === '-:') {
    // Indexed part select (compact): width is the value after +: or -:
    return decimalNumber(tokens[4]);
  }
  if (tokens.length >= 6 && (tokens[3].value === '+' || tokens[3].value === '-') && tokens[4]?.value === ':') {
    // Indexed part select (spaced): width is the value after the colon
    return decimalNumber(tokens[5]);
  }
  if (tokens[3].value !== ':') {
    return undefined;
  }
  // Traditional range select: a[left:right] — width = |left - right| + 1
  const left = decimalNumber(tokens[2]);
  const right = decimalNumber(tokens[4]);
  return left === undefined || right === undefined ? undefined : Math.abs(left - right) + 1;
}

function trimTokens(tokens: VerilogToken[]): VerilogToken[] {
  return tokens.filter((token) => token.kind !== 'comment' && token.kind !== 'eof');
}

function trimOuterParens(tokens: VerilogToken[]): VerilogToken[] {
  let current = tokens;
  while (current[0]?.value === '(' && current[current.length - 1]?.value === ')' && findMatchingForward(current, 0, '(', ')') === current.length - 1) {
    current = current.slice(1, -1);
  }
  return current;
}

function splitTopLevelTernary(tokens: VerilogToken[]): { condition: VerilogToken[]; whenTrue: VerilogToken[]; whenFalse: VerilogToken[] } | undefined {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let question = -1;
  let nestedTernary = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    }
    if (paren !== 0 || bracket !== 0 || brace !== 0) {
      continue;
    }
    if (token.value === '?') {
      if (question >= 0) {
        nestedTernary++;
      } else {
        question = index;
      }
    } else if (token.value === ':' && question >= 0) {
      if (nestedTernary > 0) {
        nestedTernary--;
      } else {
        return {
          condition: tokens.slice(0, question),
          whenTrue: tokens.slice(question + 1, index),
          whenFalse: tokens.slice(index + 1)
        };
      }
    }
  }
  return undefined;
}

function splitTopLevelOperatorTokens(tokens: VerilogToken[], operators: Set<string>): { left: VerilogToken[]; operator: VerilogToken; right: VerilogToken[] } | undefined {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token.value === ')') {
      paren++;
    } else if (token.value === '(') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === ']') {
      bracket++;
    } else if (token.value === '[') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '}') {
      brace++;
    } else if (token.value === '{') {
      brace = Math.max(0, brace - 1);
    }
    if (paren !== 0 || bracket !== 0 || brace !== 0 || !operators.has(token.value) || index === 0 || index === tokens.length - 1) {
      continue;
    }
    if ((token.value === '+' || token.value === '-') && isUnaryContext(tokens[index - 1])) {
      continue;
    }
    return {
      left: tokens.slice(0, index),
      operator: token,
      right: tokens.slice(index + 1)
    };
  }
  return undefined;
}

function splitTopLevel(tokens: VerilogToken[], separator: string): VerilogToken[][] {
  const parts: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    }
    if (token.value === separator && paren === 0 && bracket === 0 && brace === 0) {
      parts.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts.map(trimTokens).filter((part) => part.length > 0);
}

function findMatchingForward(tokens: VerilogToken[], openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === open) {
      depth++;
    } else if (tokens[index].value === close) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function isUnaryOperator(value: string | undefined): boolean {
  return value === '!' || value === '~' || value === '&' || value === '|' || value === '^' || value === '+' || value === '-' || value === '~&' || value === '~|' || value === '~^' || value === '^~';
}

function isUnaryContext(previous: VerilogToken | undefined): boolean {
  return !previous || previous.value === '(' || previous.value === '[' || previous.value === '{' || previous.value === '?' || previous.value === ':' || previous.value === ',' || previous.kind === 'operator';
}

type ParsedNumberToken =
  | { kind: 'decimal'; digits: string }
  | { kind: 'based'; size?: number; base: string; digits: string };

function parseNumberToken(value: string): ParsedNumberToken | undefined {
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    return allDecimalDigits(value) ? { kind: 'decimal', digits: value } : undefined;
  }
  const sizeText = value.slice(0, apostrophe);
  const size = sizeText ? decimalStringToNumber(sizeText) : undefined;
  if (sizeText && size === undefined) {
    return undefined;
  }
  let index = apostrophe + 1;
  if (value[index] === 's' || value[index] === 'S') {
    index++;
  }
  const base = value[index];
  if (!base || !isBasedLiteralBase(base)) {
    return undefined;
  }
  const digits = value.slice(index + 1);
  return digits ? { kind: 'based', size, base, digits } : undefined;
}

function decimalNumber(token: VerilogToken | undefined): number | undefined {
  if (!token || token.kind !== 'number') {
    return undefined;
  }
  const parsed = parseNumberToken(token.value);
  return parsed?.kind === 'decimal' ? decimalStringToNumber(parsed.digits) : undefined;
}

function decimalStringToNumber(value: string): number | undefined {
  if (!allDecimalDigits(value)) {
    return undefined;
  }
  const parsed = Number(value.split('_').join(''));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function allDecimalDigits(value: string): boolean {
  let sawDigit = false;
  for (const char of value) {
    if (char === '_') {
      continue;
    }
    if (char < '0' || char > '9') {
      return false;
    }
    sawDigit = true;
  }
  return sawDigit;
}

function isBasedLiteralBase(char: string): boolean {
  return char === 'b' || char === 'B' || char === 'o' || char === 'O' || char === 'd' || char === 'D' || char === 'h' || char === 'H';
}

/** 宽度透传的系统函数：参数位宽 = 返回值位宽 */
function passThroughSystemFunction(value: string): boolean {
  return value === '$signed' || value === '$unsigned';
}

function minimalBitsForDecimal(text: string): number {
  try {
    const value = BigInt(text.split('_').join(''));
    if (value === 0n) {
      return 1;
    }
    return value.toString(2).length;
  } catch {
    // 溢出时回退到 32 位宽度
    return 32;
  }
}

// Verilog 算术/按位/移位运算结果按上下文位宽求值：赋给更宽的 LHS 时操作数会被零/符号扩展，不丢位。
// 因此把结果视为"可伸缩"（flexible）——仅当其最小有效位宽超过目标位宽（真正的截断）才算不匹配，
// 避免对 `wide = narrow * narrow`、`{carry, sum} = a + b`、`wide = narrow << k` 这类常见且正确的
// 写法误报。自决位宽沿用 IEEE 规则（取两操作数较大值）。
function binaryOperatorWidth(left: WidthInfo, right: WidthInfo): WidthInfo {
  if (left.width === undefined && right.width === undefined) {
    return {};
  }
  const leftWidth = left.width ?? right.width ?? 0;
  const rightWidth = right.width ?? left.width ?? 0;
  const minWidth = Math.max(left.minWidth ?? leftWidth, right.minWidth ?? rightWidth);
  return { width: Math.max(leftWidth, rightWidth), minWidth, flexible: true };
}

function flexibleWidth(info: WidthInfo): WidthInfo {
  if (info.width === undefined) {
    return {};
  }
  return { width: info.width, minWidth: info.minWidth ?? info.width, flexible: true };
}

function maxWidth(left: WidthInfo, right: WidthInfo): WidthInfo {
  if (left.width === undefined) {
    return right;
  }
  if (right.width === undefined) {
    return left;
  }
  const width = Math.max(left.width, right.width);
  const minWidth = Math.max(left.minWidth ?? left.width, right.minWidth ?? right.width);
  const flexible = Boolean(left.flexible || right.flexible);
  const result: WidthInfo = { width };
  if (flexible || minWidth !== width) {
    result.minWidth = minWidth;
  }
  if (flexible) {
    result.flexible = true;
  }
  return result;
}
