// @index course-testing — P7 raw-word RI catalog shared by generators and machine-code validation

import { parseAssemblerLine } from '../mips/core/assembler/syntax';

export type P7RiWordVariant = 'unknown-opcode' | 'unknown-funct';

export interface P7RiWordCatalogEntry {
  readonly variant: P7RiWordVariant;
  readonly word: number;
  readonly description: string;
}

/**
 * Canonical generator-owned RI encodings. Keep this catalog deliberately small:
 * every entry must be outside the P7 course ISA and must represent a distinct
 * decoder failure class that the built-in generators promise to cover.
 */
export const p7RiWordCatalog: readonly P7RiWordCatalogEntry[] = Object.freeze([
  Object.freeze({
    variant: 'unknown-opcode',
    word: 0xfc00_0000,
    description: 'unknown primary opcode 0b111111'
  }),
  Object.freeze({
    variant: 'unknown-funct',
    word: 0x0000_003f,
    description: 'unknown SPECIAL funct 0b111111'
  })
]);

const p7RiWords = new Set(p7RiWordCatalog.map((entry) => entry.word >>> 0));
const p7RiWordsByVariant = new Map(p7RiWordCatalog.map((entry) => [entry.variant, entry] as const));

export function isP7RiWord(word: number): boolean {
  return p7RiWords.has(word >>> 0);
}

export function p7RiWordEntry(variant: string | undefined): P7RiWordCatalogEntry | undefined {
  return variant === undefined
    ? p7RiWordCatalog[0]
    : p7RiWordsByVariant.get(variant as P7RiWordVariant);
}

export function p7RiWordEntryAt(occurrence: number): P7RiWordCatalogEntry {
  const index = Math.max(0, Math.floor(occurrence)) % p7RiWordCatalog.length;
  return p7RiWordCatalog[index];
}

export function p7RiWordDirective(entry: P7RiWordCatalogEntry): string {
  return `.word 0x${(entry.word >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Return the catalog RI words that occur as literal `.word` operands in an
 * instruction segment. This intentionally recognizes only literal catalog
 * values: generated sources use canonical literals, while arbitrary symbolic
 * raw words must still pass the normal machine-code whitelist.
 */
export function p7RiWordsUsedInInstructionSegments(sourceText: string): ReadonlySet<number> {
  const result = new Set<number>();
  let instructionSegment = true;
  const rawLines = sourceText.split(/\r\n|\r|\n/);
  for (let line = 0; line < rawLines.length; line++) {
    const text = line === 0 ? rawLines[line].replace(/^\uFEFF/, '') : rawLines[line];
    const parsed = parseAssemblerLine({
      sourceId: 'p7-ri-source',
      line,
      startOffset: 0,
      endOffset: text.length,
      text,
      expansionStack: []
    });
    if (parsed.kind !== 'statement') continue;
    const mnemonic = parsed.mnemonic?.toLowerCase();
    if (mnemonic === '.text' || mnemonic === '.ktext') {
      instructionSegment = true;
      continue;
    }
    if (mnemonic === '.data' || mnemonic === '.kdata') {
      instructionSegment = false;
      continue;
    }
    if (!instructionSegment || mnemonic !== '.word') continue;
    for (const operand of parsed.operands) {
      const word = parseCatalogWordLiteral(operand.text);
      if (word !== undefined) result.add(word);
    }
  }
  return result;
}

function parseCatalogWordLiteral(text: string): number | undefined {
  const normalized = text.trim().replace(/_/g, '');
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(normalized)) return undefined;
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) return undefined;
  const word = value >>> 0;
  return isP7RiWord(word) ? word : undefined;
}
