// @index p7-probe-return — Real interrupt/eret/reinterrupt programs with public architectural witnesses
import { randomBytes } from 'crypto';
import { BuiltinAsmGeneratorError, BuiltinAsmGeneratorOptions, BuiltinAsmGeneratorResult, resolveBuiltinInstructionSet } from '../randomBody';
import { ProgramWriter } from '../programWriter';
import { Random, hashSeed } from '../../random';
import { P7ProbeCommitExpectation, P7ProbeHandlerCommitExpectation, P7ProbeMetadata, P7ProbeReturnVariant, P7ProbeScenario } from '../types';
import {
  p7CauseIpExternalMask, p7ExceptionHandlerAddress, p7ExternalInterruptAckAddress,
  p7ProbeEretPoisonAddress, p7ProbeExternalArmAddress, p7ProbeKindExternal,
  p7ProbeLogBase, p7ProbeMagic, p7ProbeRecordWords, p7StatusEnableAllCourseInterrupts
} from './constants';

export const automaticReturnVariants: readonly P7ProbeReturnVariant[] = [
  'direct', 'load-jr', 'branch-delay', 'jal-delay', 'mdu'
];
const operandAddress = 0x600;
const witnessAddress = 0x604;

export function generateP7ReturnProbe(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  const instructionSet = resolveBuiltinInstructionSet(options.profile, options.instructionText);
  if (instructionSet.profile !== 'P7') throw new BuiltinAsmGeneratorError('Return probes require P7.');
  const variant = options.probeReturnVariant ?? 'direct';
  if (!automaticReturnVariants.includes(variant)) throw new BuiltinAsmGeneratorError('Unknown return probe variant.');
  const seed = options.seed?.trim() || `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const rng = new Random(hashSeed(`P7:return:${variant}:${seed}`));
  const startupValue = rng.int(1, 15);
  const slotValue = rng.int(1, 15);
  const main = new ProgramWriter(0x3000);
  const commits: P7ProbeCommitExpectation[] = [];
  const forbidden: number[] = [];
  const reachable = new Set<number>();
  const branchPcs = new Set<number>();
  let replayedLink: P7ProbeCommitExpectation | undefined;
  const emit = (instruction: string) => { reachable.add(main.pc()); main.emit(instruction); };
  const grf = (instruction: string, target: number, value: number) => {
    commits.push({ pc: main.pc(), kind: 'grf', target, value: value >>> 0 }); emit(instruction);
  };
  const store = (instruction: string, target: number, value: number) => {
    commits.push({ pc: main.pc(), kind: 'dm', target, value: value >>> 0 }); emit(instruction);
  };
  const poison = () => { forbidden.push(main.pc()); main.emit(`sw $0, ${p7ProbeEretPoisonAddress}($0)`); };
  main.raw('# Built-in BUAA CO P7 return-boundary probe');
  main.raw('# scope: standard; real interrupt handler; public macroscopic-PC return transition');
  main.raw(`# variant: ${variant}`);
  main.raw(`# seed: ${seed}`);
  main.raw(`# generated: ${(options.generatedAt ?? new Date()).toISOString()}`);
  main.raw('.data\n.align 2\n_co_data:\n    .space 12288\n.text 0x3000\nmain:');
  // Non-idempotent startup and exact commits expose replay of already retired instructions.
  grf(`addi $16, $16, ${startupValue}`, 16, startupValue);
  store('sw $16, 0($0)', 0, startupValue);
  const initialCp0: NonNullable<P7ProbeMetadata['initialCp0']> = {};
  for (const [name, cp0, address] of [['status', 12, 0x610], ['cause', 13, 0x614], ['epc', 14, 0x618]] as const) {
    grf(`mfc0 $8, $${cp0}`, 8, 0);
    initialCp0[name] = { pc: main.pc(), kind: 'dm', target: address, value: 0 };
    store(`sw $8, ${address}($0)`, address, 0);
  }
  const setupPadding = rng.int(0, 3);
  for (let index = 0; index < setupPadding; index++) {
    const value = rng.int(1, 0xffff);
    grf(`ori $19, $0, ${value}`, 19, value);
  }
  grf(`ori $21, $0, ${p7ProbeLogBase}`, 21, p7ProbeLogBase);
  grf('ori $22, $0, 1', 22, 1);
  grf('ori $17, $0, 0', 17, 0);
  grf(`ori $26, $0, ${p7StatusEnableAllCourseInterrupts}`, 26, p7StatusEnableAllCourseInterrupts);
  emit('mtc0 $26, $12');
  grf('ori $26, $0, 1', 26, 1);
  store(`sw $26, ${p7ProbeExternalArmAddress}($0)`, p7ProbeExternalArmAddress, 1);
  let firstPc: number;
  let firstEpc: number;
  let firstBd = false;
  if (variant === 'direct' || variant === 'load-jr') {
    const targetPc = main.pc() + (variant === 'direct' ? 4 : 7) * 4;
    if (variant === 'load-jr') {
      grf(`ori $8, $0, ${targetPc}`, 8, targetPc);
      store(`sw $8, ${operandAddress}($0)`, operandAddress, targetPc);
      grf('ori $8, $0, 0x3000', 8, 0x3000);
    }
    firstPc = firstEpc = main.pc();
    grf(variant === 'direct' ? `ori $8, $0, ${targetPc}` : `lw $8, ${operandAddress}($0)`, 8, targetPc);
    branchPcs.add(main.pc()); emit('jr $8');
    grf(`addi $17, $17, ${slotValue}`, 17, slotValue);
    poison();
    if (main.pc() !== targetPc) throw new BuiltinAsmGeneratorError('Return target layout mismatch.');
    main.label('_co_return_target');
    store(`sw $17, ${witnessAddress}($0)`, witnessAddress, slotValue);
  } else if (variant === 'branch-delay' || variant === 'jal-delay') {
    firstEpc = main.pc(); firstPc = firstEpc + 4; firstBd = true;
    branchPcs.add(firstEpc);
    if (variant === 'jal-delay') {
      replayedLink = { pc: main.pc(), kind: 'grf', target: 31, value: firstEpc + 8 };
      emit('jal _co_return_target');
    } else emit('beq $0, $0, _co_return_target');
    grf(`addi $17, $17, ${slotValue}`, 17, slotValue);
    poison();
    main.label('_co_return_target');
    if (variant === 'jal-delay') {
      grf('add $10, $31, $0', 10, firstEpc + 8);
      store(`sw $10, ${witnessAddress}($0)`, witnessAddress, firstEpc + 8);
    } else store(`sw $17, ${witnessAddress}($0)`, witnessAddress, slotValue);
  } else {
    const dividend = rng.int(1, 0x7fff), divisor = rng.int(1, 31);
    const quotient = Math.trunc(dividend / divisor), remainder = dividend % divisor;
    grf(`ori $8, $0, ${dividend}`, 8, dividend);
    grf(`ori $9, $0, ${divisor}`, 9, divisor);
    firstPc = firstEpc = main.pc();
    emit('div $8, $9');
    grf('mflo $10', 10, quotient);
    grf('mfhi $11', 11, remainder);
    store(`sw $10, ${witnessAddress}($0)`, witnessAddress, quotient);
    store(`sw $11, ${witnessAddress + 4}($0)`, witnessAddress + 4, remainder);
  }
  grf('ori $1, $0, 2', 1, 2);
  const donePc = commits[commits.length - 1].pc;
  main.label('_co_return_done'); branchPcs.add(main.pc());
  emit('beq $0, $0, _co_return_done'); emit('nop');

  // The handler is straight-line and has exactly one control-flow exit: eret.
  // It never writes SR/EPC/Cause, starts a Timer, or changes main-program operands.
  const handler = new ProgramWriter(p7ExceptionHandlerAddress);
  const handlerCommits: P7ProbeHandlerCommitExpectation[] = [];
  const handlerCommit = (instruction: string, expected: Omit<P7ProbeHandlerCommitExpectation, 'pc'>) => {
    handlerCommits.push({ pc: handler.pc(), ...expected }); handler.emit(instruction);
  };
  handler.raw(`.ktext 0x${p7ExceptionHandlerAddress.toString(16)}\n_co_return_handler:`);
  for (const [register, cp0, value] of [[24, 13, 'cause'], [25, 12, 'status'], [23, 14, 'epc']] as const) {
    handlerCommit(`mfc0 $${register}, $${cp0}`, { kind: 'grf', target: register, value });
  }
  handlerCommit(`lui $27, ${p7ProbeMagic >>> 16}`, { kind: 'grf', target: 27, value: (p7ProbeMagic & 0xffff0000) >>> 0 });
  handlerCommit(`ori $27, $27, ${p7ProbeMagic & 0xffff}`, { kind: 'grf', target: 27, value: p7ProbeMagic });
  const recordStore = (register: number, offset: number, value: P7ProbeHandlerCommitExpectation['value'], valueStride = 0) => {
    handlerCommit(`sw $${register}, ${offset}($21)`, {
      kind: 'dm', target: p7ProbeLogBase + offset, targetStride: p7ProbeRecordWords * 4, value, valueStride
    });
  };
  recordStore(27, 0, p7ProbeMagic);
  recordStore(22, 4, 1, 1);
  handlerCommit(`ori $27, $0, ${p7ProbeKindExternal}`, { kind: 'grf', target: 27, value: p7ProbeKindExternal });
  recordStore(27, 8, p7ProbeKindExternal);
  recordStore(25, 12, 'status'); recordStore(24, 16, 'cause'); recordStore(23, 20, 'epc');
  recordStore(0, 24, 0); recordStore(0, 28, 0);
  const ackPc = handler.pc(); handler.emit(`sb $0, ${p7ExternalInterruptAckAddress}($0)`);
  handlerCommit(`addi $21, $21, ${p7ProbeRecordWords * 4}`, {
    kind: 'grf', target: 21, value: p7ProbeLogBase + p7ProbeRecordWords * 4, valueStride: p7ProbeRecordWords * 4
  });
  handlerCommit('addi $22, $22, 1', { kind: 'grf', target: 22, value: 2, valueStride: 1 });
  const eretPc = handler.pc(); handler.emit('eret');
  forbidden.push(handler.pc()); handler.emit(`sw $0, ${p7ProbeEretPoisonAddress}($0)`);
  const allowedEpc = [...reachable].filter(pc => pc >= firstEpc && !branchPcs.has(pc - 4));
  const allowedBdEpc = [...branchPcs].filter(pc => pc >= firstEpc);
  const first: P7ProbeScenario = {
    id: 1, kind: 'external', variant: `return-${variant}-first`,
    expectedIpMask: p7CauseIpExternalMask, expectedExcCode: 0, expectedBd: firstBd,
    allowedEpc: [firstEpc], triggerPc: firstPc, victimPc: firstPc, donePc,
    armAddress: p7ProbeExternalArmAddress, armValue: 1, externalDelayCycles: 0,
    requiredPreHandlerCommits: commits.filter(commit => commit.pc < firstPc), forbiddenCommitPcs: forbidden
  };
  const second: P7ProbeScenario = {
    id: 2, kind: 'external', variant: `return-${variant}-second`,
    expectedIpMask: p7CauseIpExternalMask, expectedExcCode: 0, allowedEpc,
    donePc, afterReturnOf: { scenarioId: 1, eretPc }, forbiddenCommitPcs: forbidden,
    expectedRecords: [{ expectedIpMask: p7CauseIpExternalMask, expectedExcCode: 0, allowedEpc, allowedBdEpc }]
  };
  return {
    text: [...main.render(), ...handler.render()].join('\n') + '\n',
    seed, profile: 'P7', instructionSet: instructionSet.mnemonics,
    instructionCount: main.count(), usedInstructions: ['addi', 'ori', 'lui', 'add', 'sw', 'lw', 'sb', 'mfc0', 'mtc0', 'eret', 'beq', 'jal', 'jr', 'div', 'mfhi', 'mflo', 'nop'],
    interruptSchedule: [], mode: 'probe',
    probe: { version: 1, shard: 'return', scope: 'standard', logBase: p7ProbeLogBase,
      recordWords: p7ProbeRecordWords, initialCp0, scenarios: [first, second],
      returnBoundary: { variant, mainCommits: commits, handlerCommits, ackPc, ...(replayedLink ? { replayedLink } : {}) } }
  };
}
