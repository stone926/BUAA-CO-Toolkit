// @index course-testing — CP0 observation comparison for generated P7 random anchors
import type { TraceCompareOptions } from '../language/mips/traceCompare';
import type { ProgramImage } from '../mips/core/api';
import { decodeCourseInstructionWord } from '../mips/core/isa/decoder';
import { BUILTIN_TS_ENGINE_ID } from '../mips/providers/courseEnginePolicy';
import type { AsmCaseManifestUnion } from './manifestCodec';
import { p7CauseExcCodeMask, p7ExternalInterruptAckAddress } from './p7Hardware';
import { matchesP7ObservedWord, p7CauseObservationMask } from './p7Cp0Observation';
import { parseProbeHexWord } from './p7ProbeTraceWord';

/** The fixed generator handler consumes only defined bits before overwriting the raw sample. */
export function p7AnchorValueEquivalence(
  manifest: AsmCaseManifestUnion,
  image: ProgramImage | undefined,
  oracleId: string | undefined
): TraceCompareOptions['equivalentValues'] {
  if (!image || manifest.version !== 2 || manifest.profile !== 'P7' || manifest.p7?.probe
    || manifest.source.kind !== 'builtin' || manifest.source.generator !== 'builtin:random-asm'
    || manifest.metadata?.['source.mode'] !== 'anchor' || manifest.program.assembler.id !== BUILTIN_TS_ENGINE_ID
    || oracleId !== BUILTIN_TS_ENGINE_ID) {
    return undefined;
  }

  // The generator rejects native handler instruction overrides, including overlapping encodings.
  // Bind the comparison to actual machine words so saved handler layouts need no fixed PC table.
  const causeWritebacks = new Map<string, string>();
  for (const { name, baseAddress, words } of image.segments) {
    if (name !== 'ktext') continue;
    for (let index = 0; index < words.length; index++) {
      const target = mfc0Target(words[index], 13);
      if (target === undefined || target === 0) continue;
      if (mfc0Target(words[index + 1], 14) === target || isMaskedSyncHandlerSample(words, index, target)) {
        const pc = baseAddress + index * 4;
        causeWritebacks.set(pc.toString(16).toUpperCase().padStart(8, '0'), String(target));
      }
    }
  }
  if (!causeWritebacks.size) return undefined;

  return (oracle, dut) => oracle.kind === 'grf' && causeWritebacks.get(oracle.pc) === oracle.target
    && matchesP7ObservedWord(parseProbeHexWord(dut.value), parseProbeHexWord(oracle.value), p7CauseObservationMask);
}

function mfc0Target(word: number | undefined, cp0Register: number): number | undefined {
  return word !== undefined && ((word >>> 11) & 31) === cp0Register && decodeCourseInstructionWord(word) === 'mfc0'
    ? (word >>> 16) & 31 : undefined;
}

function isMaskedSyncHandlerSample(words: readonly number[], index: number, target: number): boolean {
  const [mask, branch, delaySlot, ack, irqReturn, epcSample] = words.slice(index + 1, index + 7);
  if (mask === undefined || (mask >>> 26) !== 0x0c || ((mask >>> 21) & 31) !== target
    || (mask & 0xffff) !== p7CauseExcCodeMask) return false;

  // andi followed by bne masked,$0 to the EPC read, or an IRQ acknowledgement and eret.
  const maskedRegister = (mask >>> 16) & 31;
  return maskedRegister !== 0 && branch === (0x14000003 | (maskedRegister << 21)) && delaySlot === 0
    && ack === 0xa0000000 + p7ExternalInterruptAckAddress && irqReturn === 0x42000018
    && mfc0Target(epcSample, 14) === target;
}
