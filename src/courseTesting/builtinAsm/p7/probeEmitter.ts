import { ProjectProfile } from '../../../projectProfile';
import { Random, hashSeed } from '../../random';
import {
  BuiltinAsmGeneratorError,
  BuiltinAsmGeneratorOptions,
  BuiltinAsmGeneratorResult,
  resolveBuiltinInstructionSet
} from '../randomBody';
import { ProgramWriter } from '../programWriter';
import { P7ProbeMetadata, P7ProbeScenarioKind } from '../types';
import {
  p7CauseExcCodeMask,
  p7CauseIpExternalMask,
  p7CauseIpTimer0Mask,
  p7CauseIpTimer1Mask,
  p7ExceptionHandlerAddress,
  p7ExternalInterruptAckAddress,
  p7ProbeKindExternal,
  p7ProbeKindInternal,
  p7ProbeKindTimer0,
  p7ProbeKindTimer1,
  p7ProbeLogBase,
  p7ProbeMagic,
  p7ProbeRecordWords,
  p7ProbeStateDonePc,
  p7ProbeStateKind,
  p7ProbeStateRecordPtr,
  p7ProbeStateScenarioId,
  p7ProbeTimerCtrlStart,
  p7ProbeTimerPreset,
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
  planProbeScenarioKinds,
  scenarioWithLocations
} from './probeScenarios';

const requiredProbeMnemonics = [
  'nop', 'ori', 'lui', 'addi', 'andi', 'beq', 'bne',
  'lw', 'sw', 'sb', 'mfc0', 'mtc0', 'eret'
] as const;

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
    : `${Date.now()}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  const rng = new Random(hashSeed(`P7:probe:${seed}:${options.probeScenarioCount ?? 4}`));
  const scenarioKinds = planProbeScenarioKinds({
    count: options.probeScenarioCount ?? 4,
    externalInterrupt: options.interrupt === true,
    timerInterrupt: options.timerInterrupt === true,
    externalIntensity: clamp01(options.externalInterruptIntensity ?? 0.25),
    timerIntensity: clamp01(options.timerIntensity ?? 0.2)
  }, rng);

  const main = new ProgramWriter(p7UserTextBaseAddress);
  const scenarios: P7ProbeMetadata['scenarios'] = [];

  emitHeader(main, instructionSet.mnemonics.join(' '), seed, options.generatedAt ?? new Date());
  emitProbePrologue(main);

  scenarioKinds.forEach((kind, index) => {
    const scenario = emitScenario(main, index + 1, kind);
    scenarios.push(scenario);
  });

  main.label('_co_probe_all_done');
  main.emit('beq $0, $0, _co_probe_all_done');
  main.emit('nop');

  const probe: P7ProbeMetadata = {
    version: 1,
    logBase: p7ProbeLogBase,
    recordWords: p7ProbeRecordWords,
    scenarios
  };
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
    usedInstructions: Array.from(new Set([
      'nop', 'ori', 'lui', 'addi', 'andi', 'beq', 'bne',
      'lw', 'sw', 'sb', 'mfc0', 'mtc0', 'eret', 'syscall'
    ].filter((mnemonic) => instructionSet.mnemonics.includes(mnemonic)))).sort(),
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
  if (!allowed.has('syscall')) {
    throw new BuiltinAsmGeneratorError('P7 probe tests require syscall for the internal-exception probe scenario.');
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
  emitDisableInterrupts(writer);
  emitClearTimers(writer);
  emitLoadImmediate(writer, '$26', p7ProbeLogBase);
  writer.emit(`sw $26, 0x${p7ProbeStateRecordPtr.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateScenarioId.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateKind.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateDonePc.toString(16)}($0)`);
}

function emitScenario(writer: ProgramWriter, id: number, kind: P7ProbeScenarioKind): P7ProbeMetadata['scenarios'][number] {
  writer.raw('');
  writer.raw(`# probe scenario ${id}: ${kind}`);
  emitScenarioGuard(writer);
  emitStoreImmediate(writer, id, p7ProbeStateScenarioId);
  emitStoreImmediate(writer, probeKindCode(kind), p7ProbeStateKind);

  if (kind === 'timer0') {
    emitStoreImmediate(writer, p7ProbeTimerPreset, p7Timer0Preset);
    emitStoreImmediate(writer, p7ProbeTimerCtrlStart, p7Timer0Ctrl);
  } else if (kind === 'timer1') {
    emitStoreImmediate(writer, p7ProbeTimerPreset, p7Timer1Preset);
    emitStoreImmediate(writer, p7ProbeTimerCtrlStart, p7Timer1Ctrl);
  }

  if (kind === 'internal') {
    const victimPc = writer.pc() + 8;
    const donePc = victimPc + 4;
    emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
    writer.emit('syscall');
    writer.label(`_co_probe_s${id}_done`);
    writer.emit(`ori $1, $0, ${id}`);
    return {
      ...scenarioWithLocations(id, kind, victimPc, donePc),
      allowedEpc: [victimPc]
    };
  }

  const donePc = writer.pc() + 24;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  const enableStartPc = writer.pc();
  emitEnableInterrupts(writer);
  const waitPc = writer.pc();
  writer.label(`_co_probe_s${id}_wait`);
  writer.emit(`beq $0, $0, _co_probe_s${id}_wait`);
  writer.emit('nop');
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  const scenario = scenarioWithLocations(id, kind, waitPc, donePc);
  return {
    ...scenario,
    allowedEpc: interruptAllowedEpcs(kind, enableStartPc, waitPc)
  };
}

function emitScenarioGuard(writer: ProgramWriter): void {
  emitDisableInterrupts(writer);
  emitClearTimers(writer);
  writer.emit(`sw $0, 0x${p7ProbeStateScenarioId.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateKind.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7ProbeStateDonePc.toString(16)}($0)`);
}

function emitDisableInterrupts(writer: ProgramWriter): void {
  writer.emit('mtc0 $0, $12');
}

function emitEnableInterrupts(writer: ProgramWriter): void {
  emitLoadImmediate(writer, '$26', p7StatusEnableAllCourseInterrupts);
  writer.emit('mtc0 $26, $12');
}

function emitClearTimers(writer: ProgramWriter): void {
  writer.emit(`sw $0, 0x${p7Timer0Ctrl.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7Timer1Ctrl.toString(16)}($0)`);
}

function interruptAllowedEpcs(kind: P7ProbeScenarioKind, enableStartPc: number, waitPc: number): number[] {
  if (kind === 'timer0' || kind === 'timer1') {
    return [enableStartPc, enableStartPc + 4, waitPc, waitPc + 4];
  }
  return [waitPc, waitPc + 4];
}

function renderProbeHandler(): string[] {
  const magicHi = (p7ProbeMagic >>> 16) & 0xffff;
  const magicLo = p7ProbeMagic & 0xffff;
  return [
    '',
    `.ktext 0x${p7ExceptionHandlerAddress.toString(16)}`,
    '_co_probe_handler:',
    '    mfc0 $24, $13',
    '    mfc0 $25, $12',
    '    mfc0 $23, $14',
    `    andi $26, $24, 0x${p7CauseExcCodeMask.toString(16)}`,
    '    bne $26, $0, _co_probe_record_internal',
    '    nop',
    `    andi $26, $24, 0x${p7CauseIpTimer0Mask.toString(16)}`,
    '    beq $26, $0, _co_probe_check_timer1',
    '    nop',
    `    sw $0, 0x${p7Timer0Ctrl.toString(16)}($0)`,
    '_co_probe_check_timer1:',
    `    andi $26, $24, 0x${p7CauseIpTimer1Mask.toString(16)}`,
    '    beq $26, $0, _co_probe_check_external',
    '    nop',
    `    sw $0, 0x${p7Timer1Ctrl.toString(16)}($0)`,
    '_co_probe_check_external:',
    `    andi $26, $24, 0x${p7CauseIpExternalMask.toString(16)}`,
    '    beq $26, $0, _co_probe_record_interrupt',
    '    nop',
    `    sb $0, 0x${p7ExternalInterruptAckAddress.toString(16)}($0)`,
    '_co_probe_record_interrupt:',
    '    lw $26, 0x27ec($0)',
    `    lui $27, 0x${magicHi.toString(16)}`,
    `    ori $27, $27, 0x${magicLo.toString(16)}`,
    '    sw $27, 0($26)',
    '    lw $27, 0x27e0($0)',
    '    sw $27, 4($26)',
    '    lw $27, 0x27e4($0)',
    '    sw $27, 8($26)',
    '    sw $25, 12($26)',
    '    sw $24, 16($26)',
    '    sw $23, 20($26)',
    '    lw $27, 0x27e4($0)',
    `    ori $22, $0, ${p7ProbeKindTimer1}`,
    '    beq $27, $22, _co_probe_aux_timer1',
    '    nop',
    `    lw $22, 0x${p7Timer0Ctrl.toString(16)}($0)`,
    '    sw $22, 24($26)',
    `    lw $22, 0x${p7Timer0Count.toString(16)}($0)`,
    '    sw $22, 28($26)',
    '    beq $0, $0, _co_probe_record_done',
    '    nop',
    '_co_probe_aux_timer1:',
    `    lw $22, 0x${p7Timer1Ctrl.toString(16)}($0)`,
    '    sw $22, 24($26)',
    `    lw $22, 0x${p7Timer1Count.toString(16)}($0)`,
    '    sw $22, 28($26)',
    '_co_probe_record_done:',
    '    addi $26, $26, 32',
    '    sw $26, 0x27ec($0)',
    '    lw $23, 0x27e8($0)',
    '    mtc0 $23, $14',
    '    eret',
    '_co_probe_record_internal:',
    '    lw $26, 0x27ec($0)',
    `    lui $27, 0x${magicHi.toString(16)}`,
    `    ori $27, $27, 0x${magicLo.toString(16)}`,
    '    sw $27, 0($26)',
    '    lw $27, 0x27e0($0)',
    '    sw $27, 4($26)',
    '    lw $27, 0x27e4($0)',
    '    sw $27, 8($26)',
    '    sw $25, 12($26)',
    '    sw $24, 16($26)',
    '    sw $23, 20($26)',
    '    sw $0, 24($26)',
    '    sw $0, 28($26)',
    '    addi $26, $26, 32',
    '    sw $26, 0x27ec($0)',
    '    addi $23, $23, 4',
    '    mtc0 $23, $14',
    '    eret'
  ];
}

function emitStoreImmediate(writer: ProgramWriter, value: number, address: number): void {
  emitLoadImmediate(writer, '$26', value);
  writer.emit(`sw $26, 0x${address.toString(16)}($0)`);
}

function emitLoadImmediate(writer: ProgramWriter, register: string, value: number): void {
  const normalized = value >>> 0;
  const hi = (normalized >>> 16) & 0xffff;
  const lo = normalized & 0xffff;
  if (hi) {
    writer.emit(`lui ${register}, 0x${hi.toString(16)}`);
    if (lo) {
      writer.emit(`ori ${register}, ${register}, 0x${lo.toString(16)}`);
    }
  } else {
    writer.emit(`ori ${register}, $0, 0x${lo.toString(16)}`);
  }
}

function probeKindCode(kind: P7ProbeScenarioKind): number {
  switch (kind) {
    case 'external':
      return p7ProbeKindExternal;
    case 'timer0':
      return p7ProbeKindTimer0;
    case 'timer1':
      return p7ProbeKindTimer1;
    case 'internal':
      return p7ProbeKindInternal;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}
