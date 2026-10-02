// @index mips-core — Canonical assembler directive surface for runtime and language tooling

export const assemblerDirectives: readonly string[] = Object.freeze([
  '.data', '.text', '.kdata', '.ktext', '.word', '.half', '.byte', '.float', '.double',
  '.space', '.ascii', '.asciiz', '.align', '.globl', '.extern', '.set', '.eqv', '.macro', '.end_macro', '.include'
]);
const directives = new Set(assemblerDirectives);

export function isAssemblerDirective(mnemonic: string): boolean {
  return directives.has(mnemonic.toLowerCase());
}
