// @index mips-core — CLI/Worker 共用的纯 ISA encode/decode 服务投影
import {
  decodeCourseInstructionWord,
  InstructionScope,
  matchRuntimeInstruction
} from './decoder';
import { EncodeOperands, encodeInstructionWord } from './encoder';

export interface IsaDecodeServiceResult {
  word: string;
  runtimeRecognized: boolean;
  runtimeCandidates: readonly string[];
  exactMnemonic?: string;
  canonicalMnemonic?: string;
}

export interface IsaEncodeServiceResult {
  mnemonic: string;
  word: string;
}

/** Stable unsigned 32-bit JSON representation used by the public JSONL protocol. */
export function formatInstructionWord(word: number): string {
  return `0x${(word >>> 0).toString(16).padStart(8, '0')}`;
}

/** Parse the protocol's fixed-width unsigned word representation. */
export function parseInstructionWord(value: string): number {
  if (!/^0x[0-9a-fA-F]{8}$/.test(value)) {
    throw new Error(`instruction word must be 0x followed by exactly 8 hex digits: ${value}`);
  }
  return Number.parseInt(value.slice(2), 16) >>> 0;
}

/** Project catalog matching into a compact, stable result without leaking generated entries. */
export function decodeInstructionForService(
  word: number,
  scope: InstructionScope
): IsaDecodeServiceResult {
  const runtime = matchRuntimeInstruction(word, scope);
  const canonicalMnemonic = decodeCourseInstructionWord(word, scope);
  return {
    word: formatInstructionWord(word),
    runtimeRecognized: runtime !== undefined,
    runtimeCandidates: runtime?.candidates.map((entry) => entry.mnemonic) ?? [],
    ...(runtime?.exactInstruction ? { exactMnemonic: runtime.exactInstruction.mnemonic } : {}),
    ...(canonicalMnemonic ? { canonicalMnemonic } : {})
  };
}

export function encodeInstructionForService(
  mnemonic: string,
  operands: EncodeOperands
): IsaEncodeServiceResult {
  return {
    mnemonic,
    word: formatInstructionWord(encodeInstructionWord(mnemonic, operands))
  };
}
