import { lexVerilog, VerilogToken } from './lexer';
import { verilogCodeTokens } from './directiveBoundaries';

/** Trace evidence follows the same active branches as the source parser. */
export function extractVerilogDisplayFormats(text: string): string[] {
  return extractVerilogDisplayFormatsFromTokens(verilogCodeTokens(text, lexVerilog(text).tokens));
}

/** Reuse already selected parser tokens without lexing or preprocessing again. */
export function extractVerilogDisplayFormatsFromTokens(tokens: readonly VerilogToken[]): string[] {
  const formats: string[] = [];
  for (let index = 0; index < tokens.length - 2; index++) {
    if (tokens[index].kind !== 'systemIdentifier' || tokens[index].value !== '$display' || tokens[index + 1].value !== '(') continue;
    const format = tokens[index + 2];
    if (format.kind === 'string' && format.value.length >= 2 && format.value.endsWith('"')) {
      formats.push(format.value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
    }
  }
  return formats;
}
