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
import { P7ProbeCommitExpectation, P7ProbeMetadata, P7ProbeScenario, P7ProbeScenarioKind } from '../types';
import {
  p7CauseExcCodeMask,
  p7CauseIpExternalMask,
  p7CauseIpTimer0Mask,
  p7CauseIpTimer1Mask,
  p7ExceptionHandlerAddress,
  p7ExternalInterruptAckAddress,
  p7ProbeDefaultScenarioCount,
  p7ProbeEretPoisonAddress,
  p7ProbeExternalArmAddress,
  p7ProbeFlagRecordHiLo,
  p7ProbeFlagRecordTimer0Count,
  p7ProbeFlagRecordTimer0Ctrl,
  p7ProbeFlagRecordTimer0Preset,
  p7ProbeFlagRecordTimer1Count,
  p7ProbeFlagRecordTimer1Ctrl,
  p7ProbeFlagRecordTimer1Preset,
  p7ProbeFlagRepeatTimerInterrupt,
  p7ProbeFlagRepeatTimerCaptured,
  p7ProbeFlagRepeatTimerFreshArmed,
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
  p7ProbeMaskedInterruptMarkerAddress,
  p7ProbeMode1DeassertMarkerBase,
  p7ProbeMode1FailureMarker,
  p7ProbePostEretStatusAddress,
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
  p7StatusEnableAllCourseInterrupts,
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
  emitLoadImmediate,
  emitPadding,
  emitPaddingCount,
  emitStoreImmediate,
  loadImmediateInstructions,
  paddingProfile
} from './probeAsm';
import { renderResourceTemplate } from '../../../templates/templateRegistry';

const requiredProbeMnemonics = [
  'nop', 'add', 'sub', 'sltu', 'ori', 'lui', 'addi', 'andi', 'beq', 'bne', 'jal', 'jr',
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
  const seed = options.seed && options.seed.trim()
    ? options.seed.trim()
    : `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const scenarioCount = clampProbeScenarioCount(options.probeScenarioCount ?? p7ProbeDefaultScenarioCount);
  const shard = options.probeShard ?? 'all';
  const rng = new Random(hashSeed(`P7:probe:v4:${shard}:${seed}:${scenarioCount}`));
  const exceptionTypes = normalizeP7ExceptionTypes(options.exceptionTypes);
  const scenarioKinds = planProbeScenarioKinds({
    count: scenarioCount,
    externalInterrupt: options.interrupt === true,
    timerInterrupt: options.timerInterrupt === true,
    externalIntensity: clamp01(options.externalInterruptIntensity ?? 0.25),
    timerIntensity: clamp01(options.timerIntensity ?? 0.2),
    exceptionTypes,
    shard
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
    throw new BuiltinAsmGeneratorError(`Internal P7 probe plan generated ${main.count()} user-text instructions, exceeding the ${p7ProbeMainInstructionMaximum()} instruction budget before 0x${p7ExceptionHandlerAddress.toString(16)}.`);
  }

  const probe: P7ProbeMetadata = {
    version: 1,
    shard,
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
    usedInstructions: [...requiredProbeMnemonics].sort(),
    interruptSchedule: [],
    mode: 'probe',
    probe
  };
}

function emitHeader(writer: ProgramWriter, instructionSet: string, seed: string, generatedAt: Date): void {
  writer.raw('# Built-in BUAA CO P7 probe ASM test');
  writer.raw('# profile: P7');
  writer.raw(`# seed: ${seed}`);
  writer.raw(`# generated: ${generatedAt.toISOString()}`);
  writer.raw(`# instruction_set: ${instructionSet}`);
  writer.raw('# instruction_set_scope: randomized payload focus; probe harness uses the fixed P7 course ISA');
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

  if (kind === 'external' && variant?.startsWith('priority-')) {
    return emitInterruptPriorityScenario(writer, id, variant, rng, padding);
  }
  if (kind === 'external' && (variant === 'masked-ie' || variant === 'masked-im2')) {
    return emitMaskedExternalScenario(writer, id, variant, rng, padding);
  }
  if (kind === 'external' && isExternalRetryVariant(variant)) {
    return emitExternalRetryScenario(writer, id, variant!, rng, padding);
  }
  if ((kind === 'timer0' || kind === 'timer1') && variant === 'mode1-repeat') {
    return emitTimerMode1RepeatScenario(writer, id, kind, variant, rng, padding);
  }
  if ((kind === 'timer0' || kind === 'timer1') && variant === 'disable-reload') {
    return emitTimerDisableReloadScenario(writer, id, kind, variant, rng, padding);
  }
  if ((kind === 'timer0' || kind === 'timer1') && variant === 'write-priority') {
    return emitTimerWritePriorityScenario(writer, id, kind, variant, rng, padding);
  }

  if (isInternalProbeKind(kind)) {
    return emitInternalScenario(writer, id, kind, variant, rng, padding);
  }
  return emitInterruptScenario(writer, id, kind, variant, rng, padding);
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
  const observePostEretStatus = kind === 'syscall' && variant === 'post-eret-status';
  if (victimPlan.recordHiLo) {
    emitStoreImmediate(writer, p7ProbeFlagRecordHiLo, p7ProbeStateFlags);
  } else if (victimPlan.timerObservation) {
    emitStoreImmediate(writer, timerObservationFlag(victimPlan.timerObservation), p7ProbeStateFlags);
  }
  const resumePc = writer.pc() + (internalDonePcStoreInstructionCount + victimPlan.instructions.length) * 4;
  emitStoreImmediate(writer, resumePc, p7ProbeStateDonePc);
  const victimSequencePc = writer.pc();
  for (const instruction of victimPlan.instructions) {
    writer.emit(instruction);
  }
  const victim = resolveInternalExceptionVictim(victimPlan, victimSequencePc);
  if (writer.pc() !== resumePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 probe scenario ${id} return PC was miscalculated.`);
  }
  writer.label(doneLabel);
  const requiredCommits: P7ProbeCommitExpectation[] = [];
  if (observePostEretStatus) {
    const statusReadPc = writer.pc();
    writer.emit('mfc0 $8, $12');
    requiredCommits.push({
      pc: statusReadPc,
      kind: 'grf' as const,
      target: 8,
      value: p7StatusEnableAllCourseInterrupts
    });
    const statusStorePc = writer.pc();
    writer.emit(`sw $8, 0x${p7ProbePostEretStatusAddress.toString(16)}($0)`);
    requiredCommits.push({
      pc: statusStorePc,
      kind: 'dm' as const,
      target: p7ProbePostEretStatusAddress,
      value: p7StatusEnableAllCourseInterrupts
    });
  }
  const completionPc = writer.pc();
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);
  return {
    ...scenarioWithLocations(id, kind, victim.epc, completionPc),
    expectedExcCode: expectedExcCode(kind),
    expectedBd: victim.expectedBd,
    allowedEpc: [victim.epc],
    variant,
    victimPc: victim.victimPc,
    requireCompletion: true,
    ...(requiredCommits.length ? { requiredCommits } : {}),
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
  const exceptionKind = priorityExceptionKind(variant);
  const setup = exceptionKind === 'ov'
    ? loadImmediateInstructions('$8', 0x7fffffff)
    : [];
  for (const instruction of setup) {
    writer.emit(instruction);
  }
  emitStoreImmediate(writer, p7ProbeFlagResumeInterruptEpc, p7ProbeStateFlags);
  // donePc follows: done-PC store, arm store, interrupt enable, and one exception victim.
  const donePc = writer.pc() + 7 * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
  emitEnableInterrupts(writer);
  const victimPc = writer.pc();
  writer.emit(priorityVictimInstruction(exceptionKind));
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
        expectedExcCode: expectedExcCode(exceptionKind),
        expectedBd: false,
        allowedEpc: [victimPc]
      }
    ],
    requireCompletion: true
  };
}

function priorityExceptionKind(variant: string): 'adel' | 'ades' | 'syscall' | 'ov' {
  const kind = variant.slice('priority-'.length);
  if (kind === 'adel' || kind === 'ades' || kind === 'syscall' || kind === 'ov') {
    return kind;
  }
  throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported P7 priority probe variant ${variant}.`);
}

function priorityVictimInstruction(kind: 'adel' | 'ades' | 'syscall' | 'ov'): string {
  switch (kind) {
    case 'adel':
      return 'lw $8, 1($0)';
    case 'ades':
      return 'sw $8, 1($0)';
    case 'syscall':
      return 'syscall';
    case 'ov':
      return 'addi $9, $8, 1';
  }
}

function emitMaskedExternalScenario(
  writer: ProgramWriter,
  id: number,
  variant: 'masked-ie' | 'masked-im2',
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  if (variant === 'masked-ie') {
    emitLoadImmediate(writer, '$26', p7StatusEnableAllCourseInterrupts & ~1);
    writer.emit('mtc0 $26, $12');
  } else {
    emitLoadImmediate(writer, '$26', p7StatusEnableAllCourseInterrupts & ~p7CauseIpExternalMask);
    writer.emit('mtc0 $26, $12');
  }

  // After these 16 instructions, the handler resumes at the completion marker. The marker is
  // deliberately younger than the masked trigger and older than the enabling mtc0.
  const donePc = writer.pc() + 16 * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
  const triggerPc = writer.pc();
  writer.emit(`ori $8, $0, ${id}`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit('nop');
  const markerValue = 0x6000 | id;
  emitLoadImmediate(writer, '$8', markerValue);
  const markerPc = writer.pc();
  writer.emit(`sw $8, 0x${p7ProbeMaskedInterruptMarkerAddress.toString(16)}($0)`);
  const enableWritePc = writer.pc() + 4;
  emitEnableInterrupts(writer);
  writer.emit('nop');
  writer.emit('nop');
  const waitPc = writer.pc();
  writer.label(`_co_probe_s${id}_wait`);
  writer.emit(`beq $0, $0, _co_probe_s${id}_wait`);
  writer.emit('nop');
  if (writer.pc() !== donePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 masked interrupt scenario ${id} return PC was miscalculated.`);
  }
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  return {
    ...scenarioWithLocations(id, 'external', waitPc, donePc),
    variant,
    triggerPc,
    waitPc,
    allowedEpc: pcRange(enableWritePc, waitPc),
    armAddress: p7ProbeExternalArmAddress,
    armValue: id,
    externalDelayCycles: 0,
    requireCompletion: true,
    requiredPreHandlerCommits: [{
      pc: markerPc,
      kind: 'dm',
      target: p7ProbeMaskedInterruptMarkerAddress,
      value: markerValue
    }]
  };
}

function emitInterruptScenario(
  writer: ProgramWriter,
  id: number,
  kind: P7ProbeScenarioKind,
  variant: string | undefined,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const timerPreset = kind === 'timer0' || kind === 'timer1'
    ? timerPresetForVariant(variant, rng)
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
  const allowedEpc = interruptAllowedEpcs(kind, enableStartPc, safeWindowStart, waitPc);
  const pulseIpMask = kind === 'timer0'
    ? p7CauseIpTimer0Mask
    : kind === 'timer1'
      ? p7CauseIpTimer1Mask
      : undefined;
  const timerExpectedRecords = pulseIpMask === undefined
    ? undefined
    : variant?.startsWith('mode0-')
        ? [{
            expectedIpMask: pulseIpMask,
            expectedExcCode: 0,
            allowedEpc,
            allowedAuxPairs: [[8, 0] as [number, number]],
            auxPairDescription: `${kind} one-shot CTRL/COUNT before handler clear`
          }]
        : undefined;
  return {
    ...scenario,
    variant,
    allowedEpc,
    timerPreset,
    armAddress: kind === 'external' ? p7ProbeExternalArmAddress : undefined,
    armValue: kind === 'external' ? id : undefined,
    externalDelayCycles,
    requireCompletion: true,
    ...(timerExpectedRecords ? { expectedRecords: timerExpectedRecords } : {})
  };
}

function timerPresetForVariant(variant: string | undefined, rng: Random): number {
  if (variant?.endsWith('-min')) {
    return p7ProbeTimerPresetMin;
  }
  if (variant?.endsWith('-max')) {
    return p7ProbeTimerPresetMax;
  }
  if (variant === 'mode1-repeat') {
    return Math.max(p7ProbeTimerPresetMin, 4);
  }
  return rng.int(p7ProbeTimerPresetMin, p7ProbeTimerPresetMax);
}

/**
 * Prove that Mode 1 really starts a new period instead of merely keeping IRQ
 * asserted.  The first handler entry masks the device at CTRL (IM=0), captures
 * CP0, and redirects EPC here.  User code then observes two COUNT reloads while
 * CPU interrupts are off, re-enables the device interrupt, proves the old IP is
 * gone through Cause, and only then arms the handler to accept a fresh IRQ.
 */
function emitTimerMode1RepeatScenario(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1',
  variant: 'mode1-repeat',
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const count = kind === 'timer0' ? p7Timer0Count : p7Timer1Count;
  const ipMask = kind === 'timer0' ? p7CauseIpTimer0Mask : p7CauseIpTimer1Mask;
  const initialWaitLabel = `_co_probe_s${id}_mode1_initial_wait`;
  const followupLabel = `_co_probe_s${id}_mode1_followup`;
  const pollLabel = `_co_probe_s${id}_mode1_poll`;
  const noReloadLabel = `_co_probe_s${id}_mode1_no_reload`;
  const highCountLabel = `_co_probe_s${id}_mode1_wait_high`;
  const freshWaitLabel = `_co_probe_s${id}_mode1_fresh_wait`;
  const doneLabel = `_co_probe_s${id}_done`;
  const badLabel = `_co_probe_s${id}_bad_mode1_period`;
  const badLoopLabel = `_co_probe_s${id}_bad_mode1_period_loop`;
  const afterBadLabel = `_co_probe_s${id}_after_bad_mode1_period`;
  const timerPreset = 32;
  const mode1WithInterrupt = 0xb;
  const deassertMarker = p7ProbeMode1DeassertMarkerBase | id;

  emitStoreImmediate(writer, p7ProbeFlagRepeatTimerInterrupt, p7ProbeStateFlags);
  emitStoreImmediate(writer, timerPreset, preset);
  emitStoreImmediate(writer, mode1WithInterrupt, ctrl);

  // The first interrupt handler redirects EPC past the initial wait loop.
  const followupPc = writer.pc() + 6 * 4;
  emitStoreImmediate(writer, followupPc, p7ProbeStateDonePc);
  const firstEnableStartPc = writer.pc();
  emitEnableInterrupts(writer);
  const initialWaitPc = writer.pc();
  writer.label(initialWaitLabel);
  writer.emit(`beq $0, $0, ${initialWaitLabel}`);
  writer.emit('nop');
  if (writer.pc() !== followupPc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 Mode-1 scenario ${id} follow-up PC was miscalculated.`);
  }

  writer.label(followupLabel);
  emitDisableInterrupts(writer);
  writer.emit(`lw $10, 0x${count.toString(16)}($0)`);
  writer.emit('ori $11, $0, 0');
  writer.emit('ori $14, $0, 2');
  writer.label(pollLabel);
  writer.emit(`lw $12, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit('sltu $13, $10, $12');
  writer.emit(`beq $13, $0, ${noReloadLabel}`);
  writer.emit('nop');
  const reloadCommitPc = writer.pc();
  writer.emit('addi $11, $11, 1');
  writer.label(noReloadLabel);
  writer.emit('add $10, $12, $0');
  writer.emit(`bne $11, $14, ${pollLabel}`);
  writer.emit('nop');

  // Leave the polling loop only in the high half of a freshly reloaded period.
  writer.emit('ori $14, $0, 16');
  writer.label(highCountLabel);
  writer.emit(`lw $12, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit('sltu $13, $12, $14');
  writer.emit(`bne $13, $0, ${highCountLabel}`);
  writer.emit('nop');

  // CPU IE remains zero here. Restoring device IM must not expose the old IRQ.
  writer.emit(`ori $14, $0, 0x${mode1WithInterrupt.toString(16)}`);
  writer.emit(`sw $14, 0x${ctrl.toString(16)}($0)`);
  writer.emit('mfc0 $15, $13');
  const causeMaskPc = writer.pc();
  writer.emit(`andi $15, $15, 0x${ipMask.toString(16)}`);
  writer.emit(`bne $15, $0, ${badLabel}`);
  writer.emit('nop');
  emitLoadImmediate(writer, '$15', deassertMarker);
  const deassertMarkerPc = writer.pc();
  writer.emit(`sw $15, 0x${p7ProbeMaskedInterruptMarkerAddress.toString(16)}($0)`);

  // The second entry is accepted only after this explicit fresh-arm state.
  const completionPc = writer.pc() + 8 * 4;
  emitStoreImmediate(writer, completionPc, p7ProbeStateDonePc);
  emitStoreImmediate(
    writer,
    p7ProbeFlagRepeatTimerInterrupt | p7ProbeFlagRepeatTimerCaptured | p7ProbeFlagRepeatTimerFreshArmed,
    p7ProbeStateFlags
  );
  const freshEnableStartPc = writer.pc();
  emitEnableInterrupts(writer);
  const freshWaitPc = writer.pc();
  writer.label(freshWaitLabel);
  writer.emit(`beq $0, $0, ${freshWaitLabel}`);
  writer.emit('nop');
  if (writer.pc() !== completionPc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 Mode-1 scenario ${id} completion PC was miscalculated.`);
  }

  writer.label(doneLabel);
  writer.emit(`ori $1, $0, ${id}`);
  writer.emit(`beq $0, $0, ${afterBadLabel}`);
  writer.emit('nop');
  writer.label(badLabel);
  emitLoadImmediate(writer, '$15', p7ProbeMode1FailureMarker);
  writer.emit(`sw $15, 0x${p7ProbeMaskedInterruptMarkerAddress.toString(16)}($0)`);
  writer.label(badLoopLabel);
  writer.emit(`beq $0, $0, ${badLoopLabel}`);
  writer.emit('nop');
  writer.label(afterBadLabel);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  const firstAllowedEpcs = pcRange(firstEnableStartPc, initialWaitPc);
  const freshAllowedEpcs = pcRange(freshEnableStartPc, freshWaitPc);
  return {
    ...scenarioWithLocations(id, kind, freshWaitPc, completionPc),
    variant,
    allowedEpc: freshAllowedEpcs,
    timerPreset,
    requireCompletion: true,
    expectedRecords: [
      {
        expectedIpMask: ipMask,
        allowedIpMasks: [0, ipMask],
        expectedExcCode: 0,
        allowedEpc: firstAllowedEpcs,
        allowedBdEpc: [initialWaitPc]
      },
      {
        expectedIpMask: ipMask,
        allowedIpMasks: [0, ipMask],
        expectedExcCode: 0,
        allowedEpc: freshAllowedEpcs,
        allowedBdEpc: [freshWaitPc]
      }
    ],
    requiredPreHandlerCommits: [
      { pc: reloadCommitPc, kind: 'grf', target: 11, value: 1 },
      { pc: reloadCommitPc, kind: 'grf', target: 11, value: 2 },
      { pc: causeMaskPc, kind: 'grf', target: 15, value: 0 },
      { pc: deassertMarkerPc, kind: 'dm', target: p7ProbeMaskedInterruptMarkerAddress, value: deassertMarker }
    ]
  };
}

function emitTimerDisableReloadScenario(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1',
  variant: 'disable-reload',
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const count = kind === 'timer0' ? p7Timer0Count : p7Timer1Count;
  const badLabel = `_co_probe_s${id}_bad_timer_state`;
  const afterBadLabel = `_co_probe_s${id}_after_bad_timer_state`;

  emitDisableInterrupts(writer);
  emitStoreImmediate(writer, 32, preset);
  emitStoreImmediate(writer, 1, ctrl);
  for (let i = 0; i < 8; i++) {
    writer.emit('nop');
  }
  writer.emit(`sw $0, 0x${ctrl.toString(16)}($0)`);
  for (let i = 0; i < 4; i++) {
    writer.emit('nop');
  }
  writer.emit(`lw $10, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  for (let i = 0; i < 8; i++) {
    writer.emit('nop');
  }
  writer.emit(`lw $11, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit(`bne $10, $11, ${badLabel}`);
  writer.emit('nop');

  emitStoreImmediate(writer, 0x100, preset);
  emitStoreImmediate(writer, 1, ctrl);
  for (let i = 0; i < 8; i++) {
    writer.emit('nop');
  }
  writer.emit(`lw $11, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit('sltu $12, $10, $11');
  writer.emit(`beq $12, $0, ${badLabel}`);
  writer.emit('nop');
  writer.emit(`sw $0, 0x${ctrl.toString(16)}($0)`);
  emitEnableInterrupts(writer);

  const resumePc = writer.pc() + 3 * 4;
  emitStoreImmediate(writer, resumePc, p7ProbeStateDonePc);
  const victimPc = writer.pc();
  writer.emit('syscall');
  if (writer.pc() !== resumePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 timer reload scenario ${id} return PC was miscalculated.`);
  }
  writer.label(`_co_probe_s${id}_done`);
  const completionPc = writer.pc();
  writer.emit(`ori $1, $0, ${id}`);
  writer.emit(`beq $0, $0, ${afterBadLabel}`);
  writer.emit('nop');
  writer.label(badLabel);
  writer.emit(`beq $0, $0, ${badLabel}`);
  writer.emit('nop');
  writer.label(afterBadLabel);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  return {
    ...scenarioWithLocations(id, kind, victimPc, completionPc),
    variant,
    expectedIpMask: 0,
    expectedExcCode: expectedExcCode('syscall'),
    expectedBd: false,
    allowedEpc: [victimPc],
    victimPc,
    timerPreset: 32,
    requireCompletion: true
  };
}

/**
 * Observe the timer RTL's top-level `else if (WE)` priority through architectural
 * loads.  With three consecutive timer writes the state machine must remain in
 * IDLE.  The following three COUNT loads therefore see 0, 0, PRESET while their
 * own non-WE edges advance IDLE -> LOAD -> CNT.  A timer that also advances its
 * FSM on a write edge produces a different sequence and is trapped in `badLabel`.
 */
function emitTimerWritePriorityScenario(
  writer: ProgramWriter,
  id: number,
  kind: 'timer0' | 'timer1',
  variant: 'write-priority',
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const ctrl = kind === 'timer0' ? p7Timer0Ctrl : p7Timer1Ctrl;
  const preset = kind === 'timer0' ? p7Timer0Preset : p7Timer1Preset;
  const count = kind === 'timer0' ? p7Timer0Count : p7Timer1Count;
  const badLabel = `_co_probe_s${id}_bad_timer_write_priority`;
  const afterBadLabel = `_co_probe_s${id}_after_bad_timer_write_priority`;
  const finalPreset = 0x40;

  emitDisableInterrupts(writer);
  emitNormalizeTimerToIdleZero(writer, ctrl, preset);

  emitLoadImmediate(writer, '$8', 0x20);
  emitLoadImmediate(writer, '$9', 1);
  emitLoadImmediate(writer, '$10', finalPreset);

  // Keep these six accesses adjacent: their M-stage cadence is the invariant.
  writer.emit(`sw $8, 0x${preset.toString(16)}($0)`);
  writer.emit(`sw $9, 0x${ctrl.toString(16)}($0)`);
  writer.emit(`sw $10, 0x${preset.toString(16)}($0)`);
  const firstLoadPc = writer.pc();
  writer.emit(`lw $11, 0x${count.toString(16)}($0)`);
  const secondLoadPc = writer.pc();
  writer.emit(`lw $12, 0x${count.toString(16)}($0)`);
  const thirdLoadPc = writer.pc();
  writer.emit(`lw $13, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit(`bne $11, $0, ${badLabel}`);
  writer.emit('nop');
  writer.emit(`bne $12, $0, ${badLabel}`);
  writer.emit('nop');
  writer.emit(`bne $13, $10, ${badLabel}`);
  writer.emit('nop');

  // Repeat with CTRL as the third adjacent write. On that edge CTRL is already
  // enabled, so an implementation which ignores WE priority wrongly enters LOAD.
  writer.emit(`sw $0, 0x${ctrl.toString(16)}($0)`);
  emitNormalizeTimerToIdleZero(writer, ctrl, preset);
  writer.emit(`sw $8, 0x${preset.toString(16)}($0)`);
  writer.emit(`sw $9, 0x${ctrl.toString(16)}($0)`);
  writer.emit(`sw $9, 0x${ctrl.toString(16)}($0)`);
  const ctrlFirstLoadPc = writer.pc();
  writer.emit(`lw $14, 0x${count.toString(16)}($0)`);
  const ctrlSecondLoadPc = writer.pc();
  writer.emit(`lw $15, 0x${count.toString(16)}($0)`);
  const ctrlThirdLoadPc = writer.pc();
  writer.emit(`lw $16, 0x${count.toString(16)}($0)`);
  writer.emit('nop');
  writer.emit('nop');
  writer.emit(`bne $14, $0, ${badLabel}`);
  writer.emit('nop');
  writer.emit(`bne $15, $0, ${badLabel}`);
  writer.emit('nop');
  writer.emit(`bne $16, $8, ${badLabel}`);
  writer.emit('nop');
  writer.emit(`sw $0, 0x${ctrl.toString(16)}($0)`);
  emitEnableInterrupts(writer);

  const resumePc = writer.pc() + 3 * 4;
  emitStoreImmediate(writer, resumePc, p7ProbeStateDonePc);
  const victimPc = writer.pc();
  writer.emit('syscall');
  if (writer.pc() !== resumePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 timer write-priority scenario ${id} return PC was miscalculated.`);
  }
  writer.label(`_co_probe_s${id}_done`);
  const completionPc = writer.pc();
  writer.emit(`ori $1, $0, ${id}`);
  writer.emit(`beq $0, $0, ${afterBadLabel}`);
  writer.emit('nop');
  writer.label(badLabel);
  writer.emit(`beq $0, $0, ${badLabel}`);
  writer.emit('nop');
  writer.label(afterBadLabel);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  return {
    ...scenarioWithLocations(id, kind, victimPc, completionPc),
    variant,
    expectedIpMask: 0,
    expectedExcCode: expectedExcCode('syscall'),
    expectedBd: false,
    allowedEpc: [victimPc],
    victimPc,
    timerPreset: finalPreset,
    requireCompletion: true,
    requiredPreHandlerCommits: [
      { pc: firstLoadPc, kind: 'grf', target: 11, value: 0 },
      { pc: secondLoadPc, kind: 'grf', target: 12, value: 0 },
      { pc: thirdLoadPc, kind: 'grf', target: 13, value: finalPreset },
      { pc: ctrlFirstLoadPc, kind: 'grf', target: 14, value: 0 },
      { pc: ctrlSecondLoadPc, kind: 'grf', target: 15, value: 0 },
      { pc: ctrlThirdLoadPc, kind: 'grf', target: 16, value: 0x20 }
    ]
  };
}

function emitNormalizeTimerToIdleZero(writer: ProgramWriter, ctrl: number, preset: number): void {
  // Drive a zero-length mode-0 period to completion; COUNT is read-only.
  emitStoreImmediate(writer, 0, preset);
  emitStoreImmediate(writer, 1, ctrl);
  for (let i = 0; i < 8; i++) {
    writer.emit('nop');
  }
  writer.emit(`sw $0, 0x${ctrl.toString(16)}($0)`);
  for (let i = 0; i < 4; i++) {
    writer.emit('nop');
  }
}

function pcRange(startPc: number, endPc: number): number[] {
  const result: number[] = [];
  for (let pc = startPc; pc <= endPc; pc += 4) {
    result.push(pc);
  }
  return result;
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
  const mode1FailureMarkerHi = (p7ProbeMode1FailureMarker >>> 16) & 0xffff;
  const mode1FailureMarkerLo = p7ProbeMode1FailureMarker & 0xffff;
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
    mode1FailureMarkerHiHex: asmHex(mode1FailureMarkerHi),
    mode1FailureMarkerLoHex: asmHex(mode1FailureMarkerLo),
    mode1MarkerAddressHex: asmHex(p7ProbeMaskedInterruptMarkerAddress),
    probeKindTimer1: p7ProbeKindTimer1,
    eretPoisonAddressHex: asmHex(p7ProbeEretPoisonAddress),
    probeFlagRecordHiLo: p7ProbeFlagRecordHiLo,
    probeFlagRecordTimer0Count: p7ProbeFlagRecordTimer0Count,
    probeFlagRecordTimer0Ctrl: p7ProbeFlagRecordTimer0Ctrl,
    probeFlagRecordTimer0Preset: p7ProbeFlagRecordTimer0Preset,
    probeFlagRecordTimer1Count: p7ProbeFlagRecordTimer1Count,
    probeFlagRecordTimer1Ctrl: p7ProbeFlagRecordTimer1Ctrl,
    probeFlagRecordTimer1Preset: p7ProbeFlagRecordTimer1Preset,
    probeFlagResumeInterruptEpc: p7ProbeFlagResumeInterruptEpc,
    probeFlagRetryInterruptEpc: p7ProbeFlagRetryInterruptEpc,
    probeFlagRepeatTimerCaptured: p7ProbeFlagRepeatTimerCaptured,
    probeFlagRepeatTimerFreshArmed: p7ProbeFlagRepeatTimerFreshArmed,
    probeFlagRepeatTimerInterrupt: p7ProbeFlagRepeatTimerInterrupt,
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
