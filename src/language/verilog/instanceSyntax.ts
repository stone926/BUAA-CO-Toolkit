// @index instance-syntax — shared token boundaries for grouped module instances
import { VerilogToken } from './lexer';
import { findMatchingTokenForward, splitTopLevelTokens, trimTrailingSemicolonTokens } from './tokenUtils';

export interface VerilogInstanceTokenGroup {
  prefix: VerilogToken[];
  declarators: VerilogToken[][];
}

/** Keep the module type/parameter list separate from each instance declarator. */
export function splitInstanceTokenGroup(tokens: VerilogToken[]): VerilogInstanceTokenGroup | undefined {
  let start = 1;
  if (tokens[start]?.value === '#') {
    if (tokens[start + 1]?.value !== '(') {
      return undefined;
    }
    const close = findMatchingTokenForward(tokens, start + 1, '(', ')');
    if (close < 0) {
      return undefined;
    }
    start = close + 1;
  }
  return {
    prefix: tokens.slice(0, start),
    declarators: splitTopLevelTokens(trimTrailingSemicolonTokens(tokens).slice(start), ',', true)
  };
}
