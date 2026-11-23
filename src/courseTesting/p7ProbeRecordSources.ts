// @index course-testing — Bind ordinary handler record fields to the assembled store instructions
import type { ProgramImage } from '../mips/core/api';
import { courseInstructionImageWords } from '../mips/core/assembler/artifacts';
import type { P7ProbeMetadata, P7ProbeScenario } from './builtinAsmGenerator';
import {
  p7ExceptionHandlerAddress, p7Hardware, p7ProbePostEretStatusAddress, p7ProbeStateFirstCause,
  p7ProbeStateFirstEpc, p7ProbeStateFirstStatus, p7UserTextBaseAddress
} from './p7Hardware';
import type { P7ProbeCapturePcs } from './p7ProbeCapture';

type RecordPath = 'interrupt' | 'repeat' | 'internal' | 'priority';
type AuxiliarySource = 'zero' | 'hi-lo' | number;
const timerAddresses = new Set([p7Hardware.timer.timer0, p7Hardware.timer.timer1]
  .flatMap(timer => [timer.ctrl, timer.preset, timer.count]));

interface FieldStore {
  block: number;
  field: number;
  aux0?: number;
  auxiliarySource?: AuxiliarySource;
}

export interface P7ProbeRecordSources {
  fields: ReadonlyMap<number, FieldStore>;
  paths: ReadonlyMap<number, RecordPath>;
  replayStatus: ReadonlyMap<number, number>;
  expectedAuxiliary: ReadonlyMap<number, AuxiliarySource>;
  priorityCapture?: P7ProbeCapturePcs;
}

/** Derive record stores from the same image used by Icarus, including when
 * replaying an old ASM. The directed handler uses a relative record pointer. */
export function ordinaryProbeRecordSources(image: ProgramImage, metadata: P7ProbeMetadata): P7ProbeRecordSources {
  const fields = new Map<number, FieldStore>();
  const paths = new Map<number, RecordPath>();
  const replayStatus = new Map<number, number>();
  const labels = new Map<string, RecordPath>([
    ['_co_probe_write_interrupt_record', 'interrupt'],
    ['_co_probe_record_interrupt', 'interrupt'],
    ['_co_probe_write_repeat_timer_record', 'repeat'],
    ['_co_probe_record_internal', 'internal'],
    ['_co_probe_record_priority_exception', 'priority']
  ]);
  const pathByPc = new Map<number, RecordPath>();
  for (const symbol of image.symbols) {
    const path = labels.get(symbol.name);
    if (path !== undefined && symbol.value !== undefined) pathByPc.set(symbol.value, path);
  }
  const words = courseInstructionImageWords(image);
  const directed = metadata.shard === 'architecture' || metadata.shard === 'im-boundaries';
  const recordPointer = directed ? 19 : 26;
  const firstOffset = directed ? metadata.logBase : 0;
  let block: number | undefined;
  let path: RecordPath | undefined;
  let aux0Index: number | undefined;
  let priorityCapture: P7ProbeCapturePcs | undefined;
  for (let index = (p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4; index < words.length; index++) {
    const pc = p7UserTextBaseAddress + index * 4;
    path = pathByPc.get(pc) ?? path;
    const word = words[index];
    if (word >>> 26 !== 0x2b) continue; // sw
    const base = (word >>> 21) & 31;
    const register = (word >>> 16) & 31;
    const offset = word & 0xffff;
    // The priority path resumes the victim via eret immediately after the
    // three scratch stores. The Mode-1 capture restarts through its own path.
    if (word === storeZeroBasedWord(25, p7ProbeStateFirstStatus)
      && words[index + 1] === storeZeroBasedWord(24, p7ProbeStateFirstCause)
      && words[index + 2] === storeZeroBasedWord(23, p7ProbeStateFirstEpc)
      && words[index + 3] === 0x42000018) {
      priorityCapture = { statusPc: pc, causePc: pc + 4, epcPc: pc + 8 };
    }
    if (base === 0 && register === 25 && offset === p7ProbePostEretStatusAddress && block !== undefined) {
      replayStatus.set(block, pc);
    }
    const fieldOffset = offset - firstOffset;
    if (base !== recordPointer || fieldOffset < 0 || fieldOffset % 4 !== 0
      || fieldOffset / 4 >= metadata.recordWords) continue;
    if (fieldOffset === 0 && register === 27) {
      block = pc;
      if (path !== undefined) paths.set(block, path);
    }
    if (block === undefined) continue;
    const field = fieldOffset / 4;
    const pair = field === 7 && aux0Index !== undefined ? {
      aux0: p7UserTextBaseAddress + aux0Index * 4,
      auxiliarySource: classifyAuxiliarySource(words, aux0Index, index)
    } : {};
    fields.set(pc, { block, field, ...pair });
    aux0Index = field === 6 ? index : undefined;
  }
  const expectedAuxiliary = new Map<number, AuxiliarySource>();
  for (const scenario of metadata.scenarios) {
    if (expectedProbeRecordPath(scenario) !== 'internal') continue;
    expectedAuxiliary.set(scenario.id, expectedAuxiliarySource(scenario, words));
  }
  return { fields, paths, replayStatus, expectedAuxiliary, priorityCapture };
}

function storeZeroBasedWord(register: number, address: number): number {
  return (0xac000000 | (register << 16) | address) >>> 0;
}

function expectedAuxiliarySource(scenario: P7ProbeScenario, words: readonly number[]): AuxiliarySource {
  if (scenario.variant?.startsWith('young-')) return 'hi-lo';
  if (scenario.kind === 'ades' && scenario.victimPc !== undefined) {
    const victim = words[(scenario.victimPc - p7UserTextBaseAddress) / 4];
    const opcode = victim >>> 26;
    const address = victim & 0xffff;
    if ((opcode === 0x28 || opcode === 0x29 || opcode === 0x2b)
      && ((victim >>> 21) & 31) === 0 && timerAddresses.has(address)) return address;
  }
  return 'zero';
}

function classifyAuxiliarySource(words: readonly number[], first: number, second: number): AuxiliarySource | undefined {
  const firstRegister = (words[first] >>> 16) & 31;
  const secondRegister = (words[second] >>> 16) & 31;
  if (firstRegister === 0 && secondRegister === 0) return 'zero';
  const precedingRead = words[second - 1];
  // The internal HI/LO path loads each store's own source via mfhi/mflo.
  if (words[first - 1] === ((firstRegister << 11) | 0x10)
    && precedingRead === ((secondRegister << 11) | 0x12)) return 'hi-lo';
  const address = precedingRead & 0xffff;
  // Timer paths store the pre-victim sample in $21, then load and store the same port.
  const expectedRead = ((0x23 << 26) | (secondRegister << 16) | address) >>> 0;
  if (firstRegister === 21 && precedingRead === expectedRead && timerAddresses.has(address)) return address;
  return undefined;
}

export function expectedProbeRecordPath(scenario: P7ProbeScenario): RecordPath {
  if ((scenario.expectedRecords?.length ?? 0) > 1) {
    return scenario.expectedRecords?.[1].expectedExcCode === 0 ? 'repeat' : 'priority';
  }
  const excCode = scenario.expectedRecords?.[0].expectedExcCode ?? scenario.expectedExcCode;
  if (excCode !== undefined) return excCode === 0 ? 'interrupt' : 'internal';
  return scenario.kind === 'external' || scenario.kind === 'timer0' || scenario.kind === 'timer1'
    ? 'interrupt' : 'internal';
}
