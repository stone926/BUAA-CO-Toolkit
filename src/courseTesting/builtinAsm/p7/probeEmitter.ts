import { randomBytes } from 'crypto';
import { ProjectProfile } from '../../../projectProfile';
import { Random, hashSeed } from '../../random';
import {
  BuiltinAsmGeneratorError,
  BuiltinAsmGeneratorOptions,
  BuiltinAsmGeneratorResult,
  normalizeP7ExceptionTypes,
  resolveBuiltinInstructionSet
} from '../randomBody';
import { ProgramWriter } from '../programWriter';
import { P7ProbeMetadata, P7ProbeScenario, P7ProbeScenarioKind } from '../types';
import {
  p7CauseExcCodeMask,
  p7CauseIpExternalMask,
  p7CauseIpTimer0Mask,
  p7CauseIpTimer1Mask,
  p7ExceptionHandlerAddress,
  p7ExternalInterruptAckAddress,
  p7ProbeDefaultScenarioCount,
  p7ProbeExternalArmAddress,
  p7ProbeFlagRecordHiLo,
  p7ProbeFlagRecordTimer0Count,
  p7ProbeFlagRecordTimer0Ctrl,
  p7ProbeFlagRecordTimer0Preset,
  p7ProbeFlagRecordTimer1Count,
  p7ProbeFlagRecordTimer1Ctrl,
  p7ProbeFlagRecordTimer1Preset,
  p7ProbeFlagResumeInterruptEpc,
  p7ProbeFlagRetryInterruptEpc,
  p7ProbeKindAdel,
  p7ProbeKindAdes,
  p7ProbeKindExternal,
  p7ProbeKindInternal,
  p7ProbeKindOv,
  p7ProbeKindRi,
  p7ProbeKindSyscall,
  p7ProbeKindTimer0,
  p7ProbeKindTimer1,
  p7ProbeLogBase,
  p7ProbeMagic,
  p7ProbeRecordWords,
  p7ProbeStateDonePc,
  p7ProbeStateFlags,
  p7ProbeStateFirstCause,
  p7ProbeStateFirstEpc,
  p7ProbeStateFirstStatus,
  p7ProbeStateKind,
  p7ProbeStateRecordPtr,
  p7ProbeStateScenarioId,
  p7ProbeTimerCtrlStart,
  p7ProbeTimerPresetMax,
  p7ProbeTimerPresetMin,
  p7Timer0Ctrl,
  p7Timer0Count,
  p7Timer0Preset,
  p7Timer1Ctrl,
  p7Timer1Count,
  p7Timer1Preset,
  p7UserTextBaseAddress
} from './constants';
import {
  clampProbeScenarioCount,
  expectedExcCode,
  isInternalProbeKind,
  planProbeScenarioKinds,
  scenarioWithLocations
} from './probeScenarios';
import { probeVariantAt } from './probeVariants';
import {
  P7ProbeTimerObservation,
  planInternalExceptionVictim,
  resolveInternalExceptionVictim
} from './probeVictims';
import { emitExternalRetryScenario, isExternalRetryVariant } from './probeExternalScenarios';
import {
  ProbePaddingProfile,
  emitClearTimers,
  emitDisableInterrupts,
  emitEnableInterrupts,
  emitPadding,
  emitPaddingCount,
  emitStoreImmediate,
  loadImmediateInstructions,
  paddingProfile
} from './probeAsm';
import { renderResourceTemplate } from '../../../templates/templateRegistry';

const requiredProbeMnemonics = [
  'nop', 'add', 'sub', 'ori', 'lui', 'addi', 'andi', 'beq', 'bne', 'jal', 'jr',
  'lb', 'lh', 'lw', 'sb', 'sh', 'sw', 'mult', 'div', 'mfhi', 'mflo', 'mthi', 'mtlo',
  'mfc0', 'mtc0', 'eret', 'syscall'
] as const;
// Probe user text stays below 0x10000, so storing donePc is one ORI plus one SW.
const internalDonePcStoreInstructionCount = 2;

export function generateP7ProbeAsmTestCase(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  if (options.profile !== 'P7' as ProjectProfile) {
    throw new BuiltinAsmGeneratorError('P7 probe tests can only be generated for the P7 profile.');
  }
  const instructionSet = resolveBuiltinInstructionSet(options.profile, options.instructionText);
  if (instructionSet.profile !== 'P7') {
    throw new BuiltinAsmGeneratorError('P7 probe tests can only be generated for the P7 profile.');
  }
  validateProbeInstructionSet(new Set(instructionSet.mnemonics));

  const seed = options.seed && options.seed.trim()
    ? options.seed.trim()
    : `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const scenarioCount = clampProbeScenarioCount(options.probeScenarioCount ?? p7ProbeDefaultScenarioCount);
  const rng = new Random(hashSeed(`P7:probe:v3:${seed}:${scenarioCount}`));
  const exceptionTypes = normalizeP7ExceptionTypes(options.exceptionTypes);
  const scenarioKinds = planProbeScenarioKinds({
    count: scenarioCount,
    externalInterrupt: options.interrupt === true,
    timerInterrupt: options.timerInterrupt === true,
    externalIntensity: clamp01(options.externalInterruptIntensity ?? 0.25),
    timerIntensity: clamp01(options.timerIntensity ?? 0.2),
    exceptionTypes
  }, rng);

  const main = new ProgramWriter(p7UserTextBaseAddress);
  const scenarios: P7ProbeMetadata['scenarios'] = [];
  const padding = paddingProfile(scenarioCount);

  emitHeader(main, instructionSet.mnemonics.join(' '), seed, options.generatedAt ?? new Date());
  emitProbePrologue(main);

  const occurrences = new Map<P7ProbeScenarioKind, number>();
  scenarioKinds.forEach((kind, index) => {
    const occurrence = occurrences.get(kind) ?? 0;
    occurrences.set(kind, occurrence + 1);
    const scenario = emitScenario(main, index + 1, kind, occurrence, rng, padding);
    scenarios.push(scenario);
  });

  // Skip the callable guard on ordinary fall-through, then place the tutorial-mandated halt loop
  // at the physical end of user text. This keeps the assembled source and hardware image
  // identical and lets the common course-trace preflight recognize the tail.
  main.emit('beq $0, $0, _co_probe_all_done');
  main.emit('nop');
  emitProbeGuardSubroutine(main);
  main.label('_co_probe_all_done');
  main.emit('beq $0, $0, _co_probe_all_done');
  main.emit('nop');

  if (main.count() > p7ProbeMainInstructionMaximum()) {
    throw new BuiltinAsmGeneratorError(`P7 probe generated ${main.count()} user-text instructions, exceeding the ${p7ProbeMainInstructionMaximum()} instruction budget before 0x${p7ExceptionHandlerAddress.toString(16)}. Reduce co.test.p7.probeScenarioCount.`);
  }

  const probe: P7ProbeMetadata = {
    version: 1,
    logBase: p7ProbeLogBase,
    recordWords: p7ProbeRecordWords,
    scenarios
  };
  const probeLogCapacity = Math.floor((p7UserTextBaseAddress - p7ProbeLogBase) / (p7ProbeRecordWords * 4));
  if (scenarios.length > probeLogCapacity) {
    throw new BuiltinAsmGeneratorError(`P7 probe requires ${scenarios.length} records, exceeding the ${probeLogCapacity}-record data-memory budget.`);
  }
  const text = [
    ...main.render(),
    ...renderProbeHandler()
  ].join('\n') + '\n';

  return {
    text,
    seed,
    profile: 'P7',
    instructionSet: instructionSet.mnemonics,
    instructionCount: main.count(),
    usedInstructions: Array.from(new Set(
      requiredProbeMnemonics.filter((mnemonic) => instructionSet.mnemonics.includes(mnemonic))
    )).sort(),
    interruptSchedule: [],
    mode: 'probe',
    probe
  };
}

function validateProbeInstructionSet(allowed: Set<string>): void {
  const missing = requiredProbeMnemonics.filter((mnemonic) => !allowed.has(mnemonic));
  if (missing.length) {
    throw new BuiltinAsmGeneratorError(`P7 probe tests require instruction(s): ${missing.join(', ')}.`);
  }
}

function emitHeader(writer: ProgramWriter, instructionSet: string, seed: string, generatedAt: Date): void {
  writer.raw('# Built-in BUAA CO P7 probe ASM test');
  writer.raw('# profile: P7');
  writer.raw(`# seed: ${seed}`);
  writer.raw(`# generated: ${generatedAt.toISOString()}`);
  writer.raw(`# instruction_set: ${instructionSet}`);
  writer.raw('.data');
  writer.raw('.align 2');
  writer.raw('_co_data:');
  writer.raw('    .space 12288');
  writer.raw('.text');
  writer.raw('.globl main');
  writer.label('main');
}

function emitProbePrologue(writer: ProgramWriter): void {
  emitInstructionTemplate(writer, 'asm/p7_probe_prologue.asm', {
    externalArmAddressHex: asmHex(p7ProbeExternalArmAddress),
    loadProbeLogBase: loadImmediateInstructions('$26', p7ProbeLogBase).join('\n'),
    stateDonePcHex: asmHex(p7ProbeStateDonePc),
    stateFlagsHex: asmHex(p7ProbeStateFlags),
    stateFirstCauseHex: asmHex(p7ProbeStateFirstCause),
    stateFirstEpcHex: asmHex(p7ProbeStateFirstEpc),
    stateFirstStatusHex: asmHex(p7ProbeStateFirstStatus),
    stateKindHex: asmHex(p7ProbeStateKind),
    stateRecordPtrHex: asmHex(p7ProbeStateRecordPtr),
    stateScenarioIdHex: asmHex(p7ProbeStateScenarioId),
    timer0CtrlHex: asmHex(p7Timer0Ctrl),
    timer1CtrlHex: asmHex(p7Timer1Ctrl)
  });
}

function emitScenario(
  writer: ProgramWriter,
  id: number,
  kind: P7ProbeScenarioKind,
  occurrence: number,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const variant = probeVariantAt(kind, occurrence);
  writer.raw('');
  writer.raw(`# probe scenario ${id}: ${kind}${variant ? `/${variant}` : ''}`);
  emitScenarioGuardCall(writer);
  emitStoreImmediate(writer, id, p7ProbeStateScenarioId);
  emitStoreImmediate(writer, probeKindCode(kind), p7ProbeStateKind);
  emitPadding(writer, rng, 0, padding.setupMax);

  if (kind === 'external' && variant === 'priority-syscall') {
    return emitInterruptPriorityScenario(writer, id, variant, rng, padding);
  }
  if (kind === 'external' && isExternalRetryVariant(variant)) {
    return emitExternalRetryScenario(writer, id, variant!, rng, padding);
  }

  if (isInternalProbeKind(kind)) {
    return emitInternalScenario(writer, id, kind, variant, rng, padding);
  }
  return emitInterruptScenario(writer, id, kind, rng, padding);
}

function emitInternalScenario(
  writer: ProgramWriter,
  id: number,
  kind: P7ProbeScenarioKind,
  variant: string | undefined,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  emitEnableInterrupts(writer);
  const doneLabel = `_co_probe_s${id}_done`;
  const victimPlan = planInternalExceptionVictim(kind, variant, rng, doneLabel);
  if (victimPlan.recordHiLo) {
    emitStoreImmediate(writer, p7ProbeFlagRecordHiLo, p7ProbeStateFlags);
  } else if (victimPlan.timerObservation) {
    emitStoreImmediate(writer, timerObservationFlag(victimPlan.timerObservation), p7ProbeStateFlags);
  }
  const donePc = writer.pc() + (internalDonePcStoreInstructionCount + victimPlan.instructions.length) * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  const victimSequencePc = writer.pc();
  for (const instruction of victimPlan.instructions) {
    writer.emit(instruction);
  }
  const victim = resolveInternalExceptionVictim(victimPlan, victimSequencePc);
  if (writer.pc() !== donePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 probe scenario ${id} return PC was miscalculated.`);
  }
  writer.label(doneLabel);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);
  return {
    ...scenarioWithLocations(id, kind, victim.epc, donePc),
    expectedExcCode: expectedExcCode(kind),
    expectedBd: victim.expectedBd,
    allowedEpc: [victim.epc],
    variant,
    victimPc: victim.victimPc,
    requireCompletion: true,
    ...(victimPlan.allowedAuxPairs || victimPlan.requireEqualAuxPair ? {
      expectedRecords: [{
        expectedIpMask: 0,
        expectedExcCode: expectedExcCode(kind),
        expectedBd: victim.expectedBd,
        allowedEpc: [victim.epc],
        allowedAuxPairs: victimPlan.allowedAuxPairs,
        auxPairDescription: victimPlan.auxPairDescription,
        requireEqualAuxPair: victimPlan.requireEqualAuxPair
      }]
    } : {})
  };
}

function emitInterruptPriorityScenario(
  writer: ProgramWriter,
  id: number,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  emitStoreImmediate(writer, p7ProbeFlagResumeInterruptEpc, p7ProbeStateFlags);
  // donePc follows: done-PC store, arm store, interrupt enable, and the syscall victim.
  const donePc = writer.pc() + 7 * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
  emitEnableInterrupts(writer);
  const victimPc = writer.pc();
  writer.emit('syscall');
  if (writer.pc() !== donePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 priority probe scenario ${id} return PC was miscalculated.`);
  }
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);
  return {
    ...scenarioWithLocations(id, 'external', victimPc, donePc),
    expectedBd: false,
    allowedEpc: [victimPc],
    variant,
    victimPc,
    waitPc: victimPc,
    armAddress: p7ProbeExternalArmAddress,
    armValue: id,
    externalDelayCycles: 0,
    expectedRecords: [
      {
        expectedIpMask: p7CauseIpExternalMask,
        expectedExcCode: 0,
        expectedBd: false,
        allowedEpc: [victimPc]
      },
      {
        expectedIpMask: 0,
        expectedExcCode: 8,
        expectedBd: false,
        allowedEpc: [victimPc]
      }
    ],
    requireCompletion: true
  };
}

function emitInterruptScenario(
  writer: ProgramWriter,
  id: number,
  kind: P7ProbeScenarioKind,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const timerPreset = kind === 'timer0' || kind === 'timer1'
    ? rng.int(p7ProbeTimerPresetMin, p7ProbeTimerPresetMax)
    : undefined;
  if (kind === 'timer0') {
    emitStoreImmediate(writer, timerPreset ?? p7ProbeTimerPresetMin, p7Timer0Preset);
    emitStoreImmediate(writer, p7ProbeTimerCtrlStart, p7Timer0Ctrl);
  } else if (kind === 'timer1') {
    emitStoreImmediate(writer, timerPreset ?? p7ProbeTimerPresetMin, p7Timer1Preset);
    emitStoreImmediate(writer, p7ProbeTimerCtrlStart, p7Timer1Ctrl);
  }

  const setupPaddingCount = rng.int(0, padding.setupMax);
  const safeWindowLength = rng.int(padding.safeMin, padding.safeMax);
  const externalArmInstructionCount = kind === 'external' ? 2 : 0;
  const donePc = writer.pc() + (
    2 + setupPaddingCount + externalArmInstructionCount + 2 + safeWindowLength + 2
  ) * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  emitPaddingCount(writer, rng, setupPaddingCount);

  let externalDelayCycles: number | undefined;
  if (kind === 'external') {
    externalDelayCycles = rng.int(0, 16);
    emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
  }

  const enableStartPc = writer.pc();
  emitEnableInterrupts(writer);
  const safeWindowStart = writer.pc();
  emitPaddingCount(writer, rng, safeWindowLength);
  const waitPc = writer.pc();
  writer.label(`_co_probe_s${id}_wait`);
  writer.emit(`beq $0, $0, _co_probe_s${id}_wait`);
  writer.emit('nop');
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  const scenario = scenarioWithLocations(id, kind, waitPc, donePc);
  return {
    ...scenario,
    allowedEpc: interruptAllowedEpcs(kind, enableStartPc, safeWindowStart, waitPc),
    timerPreset,
    armAddress: kind === 'external' ? p7ProbeExternalArmAddress : undefined,
    armValue: kind === 'external' ? id : undefined,
    externalDelayCycles,
    requireCompletion: true
  };
}

function emitScenarioGuardCall(writer: ProgramWriter): void {
  writer.emit('jal _co_probe_guard');
  writer.emit('nop');
}

function emitProbeGuardSubroutine(writer: ProgramWriter): void {
  writer.raw('');
  writer.label('_co_probe_guard');
  emitDisableInterrupts(writer);
  emitClearTimers(writer);
  writer.emit(`sw $0, 0x${p7ProbeExternalArmAddress.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateScenarioId.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateKind.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateDonePc.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateFlags.toString(16)}($0)`);
  writer.emit('jr $31');
  writer.emit('nop');
}

function interruptAllowedEpcs(kind: P7ProbeScenarioKind, enableStartPc: number, safeWindowStart: number, waitPc: number): number[] {
  if (kind === 'external') {
    return [waitPc];
  }
  const startPc = kind === 'timer0' || kind === 'timer1'
    ? enableStartPc
    : safeWindowStart;
  const result: number[] = [];
  for (let pc = startPc; pc <= waitPc; pc += 4) {
    result.push(pc);
  }
  return result;
}

function renderProbeHandler(): string[] {
  const magicHi = (p7ProbeMagic >>> 16) & 0xffff;
  const magicLo = p7ProbeMagic & 0xffff;
  const recordByteLength = p7ProbeRecordWords * 4;
  const rendered = renderResourceTemplate('asm/p7_probe_handler.asm', {
    causeIpExternalMaskHex: asmHex(p7CauseIpExternalMask),
    causeIpTimer0MaskHex: asmHex(p7CauseIpTimer0Mask),
    causeIpTimer1MaskHex: asmHex(p7CauseIpTimer1Mask),
    exceptionHandlerHex: asmHex(p7ExceptionHandlerAddress),
    excCodeMaskHex: asmHex(p7CauseExcCodeMask),
    externalInterruptAckHex: asmHex(p7ExternalInterruptAckAddress),
    magicHiHex: asmHex(magicHi),
    magicLoHex: asmHex(magicLo),
    probeKindTimer1: p7ProbeKindTimer1,
    probeFlagRecordHiLo: p7ProbeFlagRecordHiLo,
    probeFlagRecordTimer0Count: p7ProbeFlagRecordTimer0Count,
    probeFlagRecordTimer0Ctrl: p7ProbeFlagRecordTimer0Ctrl,
    probeFlagRecordTimer0Preset: p7ProbeFlagRecordTimer0Preset,
    probeFlagRecordTimer1Count: p7ProbeFlagRecordTimer1Count,
    probeFlagRecordTimer1Ctrl: p7ProbeFlagRecordTimer1Ctrl,
    probeFlagRecordTimer1Preset: p7ProbeFlagRecordTimer1Preset,
    probeFlagResumeInterruptEpc: p7ProbeFlagResumeInterruptEpc,
    probeFlagRetryInterruptEpc: p7ProbeFlagRetryInterruptEpc,
    recordByteLength,
    stateDonePcHex: asmHex(p7ProbeStateDonePc),
    stateFlagsHex: asmHex(p7ProbeStateFlags),
    stateFirstCauseHex: asmHex(p7ProbeStateFirstCause),
    stateFirstEpcHex: asmHex(p7ProbeStateFirstEpc),
    stateFirstStatusHex: asmHex(p7ProbeStateFirstStatus),
    stateKindHex: asmHex(p7ProbeStateKind),
    stateRecordPtrHex: asmHex(p7ProbeStateRecordPtr),
    stateScenarioIdHex: asmHex(p7ProbeStateScenarioId),
    timer0CountHex: asmHex(p7Timer0Count),
    timer0CtrlHex: asmHex(p7Timer0Ctrl),
    timer0PresetHex: asmHex(p7Timer0Preset),
    timer1CountHex: asmHex(p7Timer1Count),
    timer1CtrlHex: asmHex(p7Timer1Ctrl),
    timer1PresetHex: asmHex(p7Timer1Preset)
  });
  return ['', ...rendered.trimEnd().split(/\r?\n/)];
}

function emitInstructionTemplate(writer: ProgramWriter, relativePath: string, values: Record<string, string | number>): void {
  for (const line of renderResourceTemplate(relativePath, values).split(/\r?\n/)) {
    const instruction = line.trim();
    if (instruction) {
      writer.emit(instruction);
    }
  }
}

function asmHex(value: number): string {
  return `0x${(value >>> 0).toString(16)}`;
}

function probeKindCode(kind: P7ProbeScenarioKind): number {
  switch (kind) {
    case 'external':
      return p7ProbeKindExternal;
    case 'timer0':
      return p7ProbeKindTimer0;
    case 'timer1':
      return p7ProbeKindTimer1;
    case 'adel':
      return p7ProbeKindAdel;
    case 'ades':
      return p7ProbeKindAdes;
    case 'syscall':
      return p7ProbeKindSyscall;
    case 'ri':
      return p7ProbeKindRi;
    case 'ov':
      return p7ProbeKindOv;
    case 'internal':
      return p7ProbeKindInternal;
  }
}

function p7ProbeMainInstructionMaximum(): number {
  // Probe main.count() already includes its physical two-instruction halt tail.
  return (p7ExceptionHandlerAddress - p7UserTextBaseAddress) / 4;
}

function timerObservationFlag(observation: P7ProbeTimerObservation): number {
  switch (observation) {
    case 'timer0-ctrl':
      return p7ProbeFlagRecordTimer0Ctrl;
    case 'timer0-preset':
      return p7ProbeFlagRecordTimer0Preset;
    case 'timer0-count':
      return p7ProbeFlagRecordTimer0Count;
    case 'timer1-ctrl':
      return p7ProbeFlagRecordTimer1Ctrl;
    case 'timer1-preset':
      return p7ProbeFlagRecordTimer1Preset;
    case 'timer1-count':
      return p7ProbeFlagRecordTimer1Count;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}
