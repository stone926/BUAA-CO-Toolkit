// @index drive-strength — normalize strength tuples for declaration and assignment parsing
import { verilogNetDeclarationTypes } from './declarations';
import { VerilogToken } from './lexer';
import { findMatchingTokenForward, splitTopLevelTokens } from './tokenUtils';

const strengths = new Set(['supply0', 'supply1', 'strong0', 'strong1', 'pull0', 'pull1', 'weak0', 'weak1', 'highz0', 'highz1']);

/** Strength affects simulation, but not symbols or expression widths. Keep original offsets. */
export function stripDriveStrength(tokens: VerilogToken[]): VerilogToken[] {
  if ((tokens[0]?.value !== 'assign' && !verilogNetDeclarationTypes.has(tokens[0]?.value)) || tokens[1]?.value !== '(') {
    return tokens;
  }
  const close = findMatchingTokenForward(tokens, 1, '(', ')');
  if (close < 0) {
    return tokens;
  }
  const parts = splitTopLevelTokens(tokens.slice(2, close), ',', true);
  return parts.length === 2 && parts.every((part) => part.length === 1 && strengths.has(part[0].value))
    ? [tokens[0], ...tokens.slice(close + 1)]
    : tokens;
}
