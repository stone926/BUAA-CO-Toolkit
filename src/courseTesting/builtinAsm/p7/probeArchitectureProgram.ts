// @index p7-probe — Reset traps, precise synchronous exceptions, CP0 masking and DM/MMIO boundaries
import type { BuiltinAsmGeneratorOptions, BuiltinAsmGeneratorResult } from '../randomBody';
import type { P7ProbeCommitExpectation } from '../types';
import { p7RiWordCatalog, p7RiWordDirective } from '../../p7RiWords';
import {
  p7CauseIpTimer0Mask, p7CauseIpTimer1Mask, p7DataMemoryWords, p7Hex, p7Timer0Count, p7Timer0Ctrl,
  p7Timer0Preset, p7Timer1Count, p7Timer1Ctrl, p7Timer1Preset, p7UserTextBaseAddress
} from './constants';
import { DirectedProbeProgram, expectRegister, expectStore } from './directedProbeProgram';
import { emitLoadImmediate, emitStoreImmediate } from './probeAsm';
import type { ProgramWriter } from '../programWriter';

const cp0IpMask = 0xfc00;
const timerSources = [
  { kind: 'timer0', ctrl: p7Timer0Ctrl, preset: p7Timer0Preset, count: p7Timer0Count, ip: p7CauseIpTimer0Mask },
  { kind: 'timer1', ctrl: p7Timer1Ctrl, preset: p7Timer1Preset, count: p7Timer1Count, ip: p7CauseIpTimer1Mask }
] as const;
const bothTimerIps = p7CauseIpTimer0Mask | p7CauseIpTimer1Mask;

export function generateP7ArchitectureProbe(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  const program = new DirectedProbeProgram(options, 'architecture');
  const { main } = program;
  const reset = program.next('syscall', 'reset-syscall');
  main.emit('syscall');
  const resetRecord = program.complete(reset, { statusBeforeException: 0, allowedEpc: [p7UserTextBaseAddress], bd: false });
  resetRecord.requiredCommits = [expectRegister(main, 'mfc0 $8, $12', 8, 0, 'status')];

  const cp0AndDm = emitCp0AndDmReadbacks(main);
  for (const [kind, victim, status, before] of [
    ['adel', 'lw $10, 1($0)', 0x1400, cp0AndDm],
    ['ades', 'sw $8, 2($0)', 0x0800, []]
  ] as const) {
    const item = program.next(kind, 'misaligned-ie-clear');
    program.prepare(item);
    writeStatus(main, status);
    const victimPc = main.pc();
    main.emit(victim);
    const poisonPc = main.pc();
    main.emit('sw $8, 0x624($0)');
    const scenario = program.complete(item, { statusBeforeException: status, allowedEpc: [victimPc], victimPc,
      bd: false, requiredPreHandlerCommits: [...before], forbiddenCommitPcs: [poisonPc] });
    scenario.requiredCommits = [expectRegister(main, 'mfc0 $8, $12', 8, status, 'status')];
  }

  writeStatus(main, 0);
  emitAdjacentFaults(program, 'adel', 'lw $10, 1($0)', 'syscall', 'syscall');
  emitAdjacentFaults(program, 'syscall', 'syscall', 'ades', 'sh $8, 1($0)');
  emitAdjacentFaults(program, 'ades', 'sw $8, 1($0)', 'ri', p7RiWordDirective(p7RiWordCatalog[0]));
  for (const [direction, lhs, rhs] of [['positive', 0x7fff_ffff, 0xffff_ffff], ['negative', 0x8000_0000, 1]] as const) {
    emitLoadImmediate(main, '$8', lhs);
    emitLoadImmediate(main, '$9', rhs);
    emitSingleFault(program, 'ov', `sub-overflow-${direction}`, 'sub $10, $8, $9');
  }

  const timerPresetWitnesses = [0x6101, 0x6201];
  timerSources.forEach((source, timer) => emitStoreImmediate(main, timerPresetWitnesses[timer], source.preset));
  emitLoadImmediate(main, '$8', 2);
  for (const [timer, source] of timerSources.entries()) {
    // Each three-register Timer occupies twelve bytes. Its fourth word is unmapped.
    const hole = source.count + 4;
    emitSingleFault(program, 'adel', `timer${timer}-decode-hole-load`, `lw $10, ${p7Hex(hole)}($0)`);
    const storeHole = emitSingleFault(program, 'ades', `timer${timer}-decode-hole-store`, `sw $8, ${p7Hex(hole)}($0)`);
    // A bridge can assert the correct exception but still leak the invalid write into
    // a Timer register. Both devices are stopped, so all readbacks are stable.
    storeHole.requiredCommits = timerSources.flatMap((device, index) => [
      expectRegister(main, `lw $10, ${p7Hex(device.ctrl)}($0)`, 10, 0),
      expectRegister(main, `lw $10, ${p7Hex(device.preset)}($0)`, 10, timerPresetWitnesses[index]),
      expectRegister(main, `lw $10, ${p7Hex(device.count)}($0)`, 10, 0)
    ]);
  }
  emitTimerMaskScenario(program, 0);
  emitTimerMaskScenario(program, 1);
  emitTimerMaskScenario(program);
  return program.finish(program.handler());
}

function emitCp0AndDmReadbacks(main: ProgramWriter): P7ProbeCommitExpectation[] {
  // Exercise all six IM bits and both IE values using only the P7 control fields.
  writeStatus(main, 0xfc01);
  const allIm = expectRegister(main, 'mfc0 $8, $12', 8, 0xfc01, 'status');
  writeStatus(main, 0xa800);
  const partialIm = expectRegister(main, 'mfc0 $8, $12', 8, 0xa800, 'status');
  emitLoadImmediate(main, '$9', p7UserTextBaseAddress);
  main.emit('mtc0 $9, $14');
  const epc = expectRegister(main, 'mfc0 $8, $14', 8, p7UserTextBaseAddress);

  const lastByte = p7DataMemoryWords * 4 - 1;
  const lastWord = lastByte - 3;
  emitLoadImmediate(main, '$8', 0x0123_4567);
  const initialWord = expectStore(main, `sw $8, ${p7Hex(lastWord)}($0)`, lastWord, 0x0123_4567);
  emitLoadImmediate(main, '$8', 0xa5);
  const byteStore = expectStore(main, `sb $8, ${p7Hex(lastByte)}($0)`, lastWord, 0xa523_4567);
  const byteLoad = expectRegister(main, `lb $9, ${p7Hex(lastByte)}($0)`, 9, 0xffff_ffa5);
  const mergedWord = expectRegister(main, `lw $10, ${p7Hex(lastWord)}($0)`, 10, 0xa523_4567);
  return [allIm, partialIm, epc, initialWord, byteStore, byteLoad, mergedWord];
}

function emitSingleFault(program: DirectedProbeProgram, kind: 'adel' | 'ades' | 'ov', variant: string, victim: string) {
  const item = program.next(kind, variant);
  const { main } = program;
  program.prepare(item);
  const victimPc = main.pc();
  main.emit(victim);
  const poisonPc = main.pc();
  main.emit('sw $8, 0x624($0)');
  return program.complete(item, { statusBeforeException: 0, allowedEpc: [victimPc], victimPc,
    bd: false, forbiddenCommitPcs: [poisonPc] });
}

function emitAdjacentFaults(
  program: DirectedProbeProgram, olderKind: 'adel' | 'ades' | 'syscall', olderInstruction: string,
  youngerKind: 'syscall' | 'ades' | 'ri', youngerInstruction: string
): void {
  const { main } = program;
  const older = program.next(olderKind, `age-before-${youngerKind}`);
  const youngerLabel = `_co_directed_s${older.id}_younger`;
  program.prepare(older);
  main.emit(`ori $8, $0, ${0x6300 | older.id}`);
  const olderWrite = expectStore(main, 'sw $8, 0x620($0)', 0x620, 0x6300 | older.id);
  const olderPc = main.pc();
  main.emit(olderInstruction);
  main.label(youngerLabel);
  const youngerPc = main.pc();
  main.emit(youngerInstruction);
  const poisonPc = main.pc();
  main.emit('sw $8, 0x624($0)');

  const first = program.complete(older, { statusBeforeException: 0, allowedEpc: [olderPc], victimPc: olderPc, bd: false,
    requiredPreHandlerCommits: [olderWrite], forbiddenCommitPcs: [youngerPc, poisonPc] });
  const between = expectStore(main, 'sw $8, 0x628($0)', 0x628, 0x6300 | older.id);
  first.requiredCommits = [between];
  const younger = program.next(youngerKind, `age-retry-after-${olderKind}`);
  program.prepare(younger);
  // Re-execute that exact younger instruction as an ordinary instruction, so it now
  // needs its own handler entry with independent EPC and Cause. Avoid a delay-slot retry.
  main.emit(`beq $0, $0, ${youngerLabel}`);
  main.emit('nop');
  program.complete(younger, { statusBeforeException: 0, allowedEpc: [youngerPc], victimPc: youngerPc,
    bd: false, requiredPreHandlerCommits: [between], forbiddenCommitPcs: [poisonPc] });
}

function emitTimerMaskScenario(program: DirectedProbeProgram, selected?: 0 | 1): void {
  const { main } = program;
  const source = timerSources[selected ?? 0];
  const opposite = timerSources[source.kind === 'timer0' ? 1 : 0];
  const variant = selected === undefined ? 'both-pending-ie-clear' : `im${selected}-only`;
  const item = program.next(source.kind, variant);
  program.prepare(item);
  // With IE set, a pending source with only the opposite IM bit enabled cannot interrupt.
  // Timer Mode 0 holds the request until CTRL masks it, allowing polling at any CPU cadence.
  const statusBeforeEnable = selected === undefined ? bothTimerIps : source.ip | 1;
  writeStatus(main, statusBeforeEnable);
  prepareTimerPending(main, item.id, opposite);
  prepareTimerPending(main, item.id, source);
  emitStoreImmediate(main, 8, opposite.ctrl);
  if (selected === undefined) emitStoreImmediate(main, 8, source.ctrl);
  const pendingBits = selected === undefined ? bothTimerIps : opposite.ip;
  const observed = observePending(main, item.id, pendingBits);
  const status = statusBeforeEnable | 1;
  if (selected === undefined) {
    emitLoadImmediate(main, '$8', status);
    main.emit('mtc0 $8, $12');
  } else {
    emitLoadImmediate(main, '$8', 8);
    main.emit(`sw $8, ${p7Hex(source.ctrl)}($0)`);
  }
  const waitLabel = `_co_directed_s${item.id}_wait`;
  const waitPc = main.pc();
  main.label(waitLabel);
  main.emit(`beq $0, $0, ${waitLabel}`);
  main.emit('nop');
  // Eligibility is an effect of the preceding mtc0/store. Both the following
  // self-branch and its delay slot report the branch PC as EPC.
  const scenario = program.complete(item, { statusBeforeException: status, ipMask: bothTimerIps, allowedEpc: [waitPc],
    waitPc, requiredPreHandlerCommits: [observed] });
  scenario.requiredCommits = [expectRegister(main, 'mfc0 $8, $12', 8, status, 'status')];
}

function prepareTimerPending(main: ProgramWriter, id: number, source: typeof timerSources[number]): void {
  // Run a fresh one-shot with the device's own IRQ output masked. When CTRL returns to
  // zero, the one-shot has stopped and its latent IRQ can be exposed by setting only IM.
  emitStoreImmediate(main, 3, source.preset);
  emitStoreImmediate(main, 1, source.ctrl);
  const done = `_co_directed_s${id}_${source.kind}_stopped`;
  main.label(done);
  main.emit(`lw $9, ${p7Hex(source.ctrl)}($0)`);
  main.emit(`bne $9, $0, ${done}`);
  main.emit('nop');
}

function observePending(main: ProgramWriter, id: number, pending: number): P7ProbeCommitExpectation {
  const poll = `_co_directed_s${id}_poll`;
  emitLoadImmediate(main, '$8', pending);
  main.label(poll);
  main.emit('mfc0 $9, $13');
  main.emit(`andi $9, $9, ${p7Hex(cp0IpMask)}`);
  main.emit(`bne $8, $9, ${poll}`);
  main.emit('nop');
  return expectStore(main, 'sw $9, 0x62c($0)', 0x62c, pending);
}

function writeStatus(main: ProgramWriter, value: number): void {
  emitLoadImmediate(main, '$8', value);
  main.emit('mtc0 $8, $12');
}
