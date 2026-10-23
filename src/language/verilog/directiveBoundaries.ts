// @index directiveBoundaries — separate compiler-directive arguments from Verilog code tokens
import { VerilogToken } from './lexer';
import { activeVerilogTokens, verilogDirectiveLineEnd, preprocessorDirectives } from './preprocessor';
import { verilogDeclarationKeywords } from './declarations';

const netTypes = new Set(['wire', 'tri', 'tri0', 'tri1', 'wand', 'triand', 'wor', 'trior', 'trireg', 'supply0', 'supply1', 'uwire', 'none']);
const timeUnits = new Set(['s', 'ms', 'us', 'ns', 'ps', 'fs']);
const oneArgumentDirectives = new Set(['begin_keywords', 'ifdef', 'ifndef', 'elsif', 'include', 'undef', 'unconnected_drive']);
const restOfLineDirectives = new Set(['define', 'pragma']);
const codeStarters = new Set([...verilogDeclarationKeywords, 'assign', 'module', 'endmodule', 'always', 'initial', 'generate', 'endgenerate', 'begin', 'end']);

/** Remove compiler-directive syntax from code parsing while keeping the original tokens available to preprocessor providers. */
export function verilogCodeTokens(text: string, tokens: VerilogToken[]): VerilogToken[] {
  tokens = activeVerilogTokens(text, tokens);
  const code: VerilogToken[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(' && tokens[index + 1]?.value === '*' && tokens[index + 2]?.value !== ')') {
      let close = index + 2;
      while (close < tokens.length && !(tokens[close].value === '*' && tokens[close + 1]?.value === ')')) close++;
      if (close < tokens.length) { index = close + 1; continue; }
    }
    const name = token.kind === 'directive' ? token.value.slice(1) : undefined;
    if (!name || !preprocessorDirectives.has(name)) {
      code.push(token);
      continue;
    }

    const lineEnd = directiveLineEnd(text, token.end, restOfLineDirectives.has(name));
    if (restOfLineDirectives.has(name)) {
      while (tokens[index + 1]?.start < lineEnd) {
        index++;
      }
      continue;
    }

    const next = (): VerilogToken | undefined => {
      const candidate = tokens[index + 1];
      return candidate && candidate.start < lineEnd && candidate.kind !== 'eof' ? candidate : undefined;
    };
    const consume = (predicate: (candidate: VerilogToken) => boolean): boolean => {
      const candidate = next();
      if (!candidate || !predicate(candidate)) {
        return false;
      }
      index++;
      return true;
    };
    const isMacroArgument = (candidate: VerilogToken): boolean =>
      candidate.kind === 'directive' && !preprocessorDirectives.has(candidate.value.slice(1));

    if (name === 'default_nettype') {
      consume((candidate) => (candidate.kind === 'identifier' || candidate.kind === 'keyword') &&
        (netTypes.has(candidate.value) || !codeStarters.has(candidate.value)));
    } else if (name === 'timescale') {
      // Both `1ns/1ps and `1 ns / 1 ps lex as number, unit, slash, number, unit.
      const first = next();
      if (consume((candidate) => candidate.kind === 'number' || isMacroArgument(candidate))) {
        if (first?.kind === 'number') {
          consume((candidate) => isTimeUnitOrInvalidArgument(candidate));
        }
        if (consume((candidate) => candidate.value === '/')) {
          const second = next();
          if (consume((candidate) => candidate.kind === 'number' || isMacroArgument(candidate)) && second?.kind === 'number') {
            consume((candidate) => isTimeUnitOrInvalidArgument(candidate));
          }
        }
      }
    } else if (name === 'line') {
      if (consume((candidate) => candidate.kind === 'number')) {
        if (consume((candidate) => candidate.kind === 'string')) {
          consume((candidate) => candidate.kind === 'number');
        }
      }
    } else if (oneArgumentDirectives.has(name)) {
      consume((candidate) => candidate.kind === 'identifier' || candidate.kind === 'string' || candidate.kind === 'keyword');
    }
  }
  return code;
}

function isTimeUnitOrInvalidArgument(token: VerilogToken): boolean {
  return timeUnits.has(token.value) || (token.kind === 'identifier' && !codeStarters.has(token.value));
}

export const directiveLineEnd = verilogDirectiveLineEnd;
