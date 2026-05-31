import { Range } from 'vscode-languageserver/node';

/**
 * 生成 Range 的唯一字符串键，用于 Set/Map 去重。
 * 共享给 mips/parser, verilog/parser, verilog/semanticTokens, verilog/service。
 */
export function rangeKey(range: Range): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

/**
 * 转义正则表达式特殊字符。
 * 共享给 mips/syntax, verilog/parser。
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 创建 MIPS 汇编 token 扫描正则（每次调用返回新实例，避免 lastIndex 共享问题）。
 * 匹配：%?identifier 或 $register。
 * 共享给 mips/navigation, mips/rename, mips/semanticTokens, mips/parser。
 */
export function createMipsTokenRegex(): RegExp {
  return /%?[A-Za-z_.$][\w.$]*|\$[A-Za-z0-9_]+/g;
}
