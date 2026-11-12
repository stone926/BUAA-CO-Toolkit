// @index link-register-faults — Bounded execution-time link/operand mutations for generated coverage tests.
import { vi } from 'vitest';
import type { ProgramImage } from '../../mips/core/api';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import type { CommitEvent } from '../../mips/core/events/commitEvent';
import { formatArchitecturalWrites, projectCommitEvents } from '../../mips/core/events/traceProjection';
import type { CourseProfile } from '../../mips/core/generated/isaCatalog';
import { executeProgramForService } from '../../mips/core/machine/executeService';
import { CourseSystemSession } from '../../mips/core/machine/system';
import { resolveCourseProfile } from '../../mips/core/profiles/courseProfiles';

export function assembleLinkProgram(text: string, profile: CourseProfile) {
  const assembled = assembleCourseSource({ id: 'link-register-coverage', text }, { profile });
  if (!assembled.ok || !assembled.image) {
    throw new Error(assembled.diagnostics.map((item) => item.message).join('\n'));
  }
  const image = assembled.image;
  const request = {
    profile, segments: image.segments, entryPc: image.entryPc,
    haltPc: findCourseHaltPc(image, profile), maxSteps: 65_536, collectTrace: true
  };
  return { image, profile, request, oracle: executeProgramForService(request) };
}

export function labelPc(image: ProgramImage, label: string): number {
  const symbol = image.symbols.find((item) => item.name === label);
  if (symbol?.value === undefined) throw new Error(`Missing label ${label}`);
  return symbol.value;
}

export function instructionAt(image: ProgramImage, pc: number): number {
  const segment = image.segments.find((item) => item.name !== 'data'
    && pc >= item.baseAddress && pc < item.baseAddress + item.words.length * 4);
  if (!segment) throw new Error(`Missing instruction at ${pc.toString(16)}`);
  return segment.words[(pc - segment.baseAddress) / 4];
}

export type LinkExecutionFault =
  | { kind: 'jal-pc-plus-four' }
  | { kind: 'operand'; pc: number; readIndex?: 0 | 1; replacement: 'minus-four' | 'previous-write' | 'older-jal' | 'zero' };

/**
 * Reuse the production interpreter with the same runtime read hooks as the
 * register/hazard witness tests. These inject architectural operand faults;
 * they neither simulate pipeline timing nor alter the resulting trace.
 */
export function executeLinkFault(
  fixture: ReturnType<typeof assembleLinkProgram>, fault?: LinkExecutionFault
) {
  const profile = resolveCourseProfile(fixture.profile);
  const session = new CourseSystemSession({
    profile: fault?.kind === 'jal-pc-plus-four' ? { ...profile, linkOffset: 4 } : profile,
    image: fixture.image, haltPc: fixture.request.haltPc, maxSteps: 16_384
  });
  const state = session.machine.state;
  const registers = state.gpr;
  const read = registers.read.bind(registers);
  const write = registers.write.bind(registers);
  let previous31: number | undefined;
  let olderJal: number | undefined;
  let hits = 0;
  let matchingReads = 0;
  let injection: { pc: number; readIndex: number; expected: number; actual: number } | undefined;
  const writeHook = vi.spyOn(registers, 'write').mockImplementation((register, value) => {
    if (register === 31) {
      previous31 = read(register);
      if ((instructionAt(fixture.image, state.pc) >>> 26) === 3) {
        olderJal = value;
        if (fault?.kind === 'jal-pc-plus-four') hits++;
      }
    }
    write(register, value);
  });
  const readHook = vi.spyOn(registers, 'read').mockImplementation((register) => {
    const expected = read(register);
    if (register !== 31 || fault?.kind !== 'operand' || state.pc !== fault.pc || hits) return expected;
    const readIndex = matchingReads++;
    if (readIndex !== (fault.readIndex ?? 0)) return expected;
    const actual = fault.replacement === 'minus-four' ? (expected - 4) >>> 0
      : fault.replacement === 'zero' ? 0
        : fault.replacement === 'older-jal' ? olderJal : previous31;
    if (actual === undefined || actual === expected) {
      throw new Error(`Fault at ${state.pc.toString(16)} has no distinct stale value`);
    }
    hits++;
    injection = { pc: state.pc, readIndex, expected, actual };
    return actual;
  });
  const events: CommitEvent[] = [];
  let status = 'committed';
  try {
    for (let step = 0; step < 16_385; step++) {
      const result = session.stepInstruction();
      if (result.event) events.push(result.event);
      status = result.status;
      if (status !== 'committed') break;
    }
  } finally {
    readHook.mockRestore();
    writeHook.mockRestore();
  }
  return {
    status, hits, injection, events, haltPc: session.courseHaltPc,
    trace: formatArchitecturalWrites(projectCommitEvents(events, profile)).split('\n').filter(Boolean)
  };
}
