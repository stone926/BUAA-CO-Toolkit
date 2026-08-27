import { ProgramImage } from '../../mips/core/api';
import { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { EncodeOperands, encodeInstructionWord } from '../../mips/core/isa/encoder';
import { CommitEvent, StepResult } from '../../mips/core/events/commitEvent';
import { ExternalInterruptRequest } from '../../mips/core/devices/interruptController';
import { MachineSession, MachineSessionOptions } from '../../mips/core/machine/session';
import {
  CourseSystemSession,
  CourseSystemSessionOptions,
  DeviceSchedule
} from '../../mips/core/machine/system';
import { buildProgramImage } from '../../mips/core/programImage';
import { courseHaltBranchWord, resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';

/**
 * Shared fixtures for the execution-core suites.
 *
 * Programs are assembled with the production encoder for readability; the
 * encoding itself is pinned independently by `isaGolden.test.ts` and by
 * `encodesTheCanonicalHaltSequence` below, so a broken encoder cannot silently
 * make an execution test assert the wrong instruction.
 */

export const textBase = 0x0000_3000;

export function op(mnemonic: string, operands: EncodeOperands = {}): number {
  return encodeInstructionWord(mnemonic, operands);
}

/** `beq $0, $0, -1` plus its delay-slot `nop` — the course completion sequence. */
export const haltSequence: readonly number[] = [courseHaltBranchWord, 0x0000_0000];

/** Build a text-only image at `0x3000`, optionally with an initial DM segment. */
export function textImage(
  words: readonly number[],
  options: {
    readonly base?: number;
    readonly entryPc?: number;
    readonly dataWords?: readonly number[];
    readonly dataBase?: number;
    readonly kernelWords?: readonly number[];
    readonly kernelBase?: number;
  } = {}
): ProgramImage {
  const base = options.base ?? textBase;
  const segments = [{ name: 'text', baseAddress: base, words: [...words] }];
  if (options.kernelWords?.length) {
    segments.push({
      name: 'ktext',
      baseAddress: options.kernelBase ?? 0x0000_4180,
      words: [...options.kernelWords]
    });
  }
  if (options.dataWords?.length) {
    segments.push({
      name: 'data',
      baseAddress: options.dataBase ?? 0x0000_0000,
      words: [...options.dataWords]
    });
  }
  return buildProgramImage({
    entryPc: options.entryPc ?? base,
    segments,
    inputGraph: [{
      id: 'fixture',
      contentHash: '0'.repeat(64)
    }]
  });
}

export interface FixtureOptions {
  readonly maxSteps?: number;
  readonly haltPc?: number;
  readonly layers?: CourseSystemSessionOptions['layers'];
  readonly undefinedBehavior?: CourseSystemSessionOptions['undefinedBehavior'];
  readonly unloadedInstruction?: CourseSystemSessionOptions['unloadedInstruction'];
  readonly externalInterrupts?: readonly ExternalInterruptRequest[];
  readonly deviceSchedule?: DeviceSchedule;
  readonly dataWords?: readonly number[];
  readonly dataBase?: number;
  readonly kernelWords?: readonly number[];
  readonly kernelBase?: number;
  readonly base?: number;
  readonly entryPc?: number;
}

/** A `CourseSystemSession` running `words` under the frozen profile contract. */
export function makeSession(
  profileId: CourseProfile,
  words: readonly number[],
  options: FixtureOptions = {}
): CourseSystemSession {
  return new CourseSystemSession({
    profile: resolveCourseProfile(profileId),
    image: textImage(words, {
      ...(options.base === undefined ? {} : { base: options.base }),
      ...(options.entryPc === undefined ? {} : { entryPc: options.entryPc }),
      ...(options.dataWords ? { dataWords: options.dataWords } : {}),
      ...(options.dataBase === undefined ? {} : { dataBase: options.dataBase }),
      ...(options.kernelWords ? { kernelWords: options.kernelWords } : {}),
      ...(options.kernelBase === undefined ? {} : { kernelBase: options.kernelBase })
    }),
    maxSteps: options.maxSteps ?? 200,
    ...(options.haltPc === undefined ? {} : { haltPc: options.haltPc }),
    ...(options.layers ? { layers: options.layers } : {}),
    ...(options.undefinedBehavior ? { undefinedBehavior: options.undefinedBehavior } : {}),
    ...(options.unloadedInstruction ? { unloadedInstruction: options.unloadedInstruction } : {}),
    ...(options.externalInterrupts ? { externalInterrupts: options.externalInterrupts } : {}),
    ...(options.deviceSchedule ? { deviceSchedule: options.deviceSchedule } : {})
  });
}

/** Bare `MachineSession` without any device port; used for P3-P6 fixtures. */
export function makeMachine(
  profileId: CourseProfile,
  words: readonly number[],
  options: Partial<MachineSessionOptions> = {}
): MachineSession {
  return new MachineSession({
    profile: resolveCourseProfile(profileId),
    image: textImage(words),
    maxSteps: 200,
    ...options
  });
}

export interface RunTrace {
  readonly events: CommitEvent[];
  readonly results: StepResult[];
  readonly last: StepResult;
}

/** Step until the session stops, or until `limit` steps have been taken. */
export function runToCompletion(
  session: CourseSystemSession | MachineSession,
  limit = 500
): RunTrace {
  const events: CommitEvent[] = [];
  const results: StepResult[] = [];
  let last: StepResult = { status: 'committed' };
  for (let index = 0; index < limit; index++) {
    last = session.stepInstruction();
    results.push(last);
    if (last.event) {
      events.push(last.event);
    }
    if (last.status !== 'committed') {
      break;
    }
  }
  return { events, results, last };
}

/** Events that actually committed architectural work, in order. */
export function committedEvents(trace: RunTrace): CommitEvent[] {
  return trace.events.filter((event) => event.kind !== 'halt');
}

/** All GPR writes across a run as `[register, value]` pairs. */
export function gprWrites(trace: RunTrace): Array<[number, number]> {
  return trace.events.flatMap((event) =>
    event.gprWrites.map((write) => [write.register, write.value] as [number, number]));
}

/** All DM writes across a run as `[wordAddress, value]` pairs. */
export function memoryWrites(trace: RunTrace): Array<[number, number]> {
  return trace.events.flatMap((event) =>
    event.memoryWrites.map((write) => [write.wordAddress, write.valueAfter] as [number, number]));
}
