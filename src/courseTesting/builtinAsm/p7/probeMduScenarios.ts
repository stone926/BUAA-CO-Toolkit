// @index p7-probe-mdu — 中断窗口内 HI/LO 的课程允许态与返回重试结果检查
import { ProgramWriter } from '../programWriter';
import { P7ProbeCommitExpectation, P7ProbeScenario } from '../types';
import { Random } from '../../random';
import { BuiltinAsmGeneratorError } from '../randomBody';
import {
  p7ProbeExternalArmAddress,
  p7ProbeFlagRecordHiLo,
  p7ProbeFlagRetryInterruptEpc,
  p7ProbeStateDonePc,
  p7ProbeStateFlags
} from './constants';
import {
  ProbePaddingProfile,
  emitDisableInterrupts,
  emitEnableInterrupts,
  emitLoadImmediate,
  emitPadding,
  emitStoreImmediate
} from './probeAsm';
import {
  emitPendingTimerRelease,
  emitTimerPendingSetup,
  pendingTimerReleaseInstructionCount
} from './probePriorityScenarios';
import { expectedIpMask, scenarioWithLocations } from './probeScenarios';
import { interruptMduVariants, MduOperation, olderMduVariants } from './probeMduOperations';

export { interruptMduVariants } from './probeMduOperations';

type InterruptKind = 'external' | 'timer0' | 'timer1';

const initialHi = 0x13579bdf;
const initialLo = 0x2468ace0;
const operand = 0xfffffff9; // -7 signed; 4294967289 unsigned.
const resultHiAddress = 0x0620;
const resultLoAddress = 0x0624;

export function isInterruptMduVariant(variant: string | undefined): boolean {
  return variant !== undefined && interruptMduVariants.includes(variant);
}

export function isOlderMduVariant(variant: string | undefined): variant is typeof olderMduVariants[number] {
  return variant !== undefined && (olderMduVariants as readonly string[]).includes(variant);
}

/**
 * Real external interrupt of a younger HI/LO reader. The MDU instruction is
 * older than the victim and must not be replayed or cancelled by the handler.
 * This observes the final architectural pair without requiring an internal
 * busy-cycle alignment that the course does not expose.
 */
export function emitOlderMduScenario(
  writer: ProgramWriter,
  id: number,
  variant: typeof olderMduVariants[number],
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  const operation: 'mult' | 'div' = variant.includes('-mult-') ? 'mult' : 'div';
  const delaySlot = variant.endsWith('-branch-delay');
  const finalPair = finalHiLo(operation);
  emitDisableInterrupts(writer);
  emitStoreImmediate(writer, p7ProbeFlagRecordHiLo | p7ProbeFlagRetryInterruptEpc, p7ProbeStateFlags);
  emitLoadImmediate(writer, '$8', initialHi);
  writer.emit('mthi $8');
  emitLoadImmediate(writer, '$8', initialLo);
  writer.emit('mtlo $8');
  const requiredPreHandlerCommits: P7ProbeCommitExpectation[] = [];
  recordRead(writer, 'mfhi', 14, initialHi, requiredPreHandlerCommits);
  recordRead(writer, 'mflo', 15, initialLo, requiredPreHandlerCommits);
  emitLoadImmediate(writer, '$8', operand);
  emitLoadImmediate(writer, '$9', 3);

  // done-PC and arm each use ORI+SW, enabling SR uses ORI+MTC0.
  // The victim sequence has 5 instructions directly, or 7 with a branch
  // and an unreachable wrong-path store.
  const donePc = writer.pc() + (6 + (delaySlot ? 7 : 5)) * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
  emitEnableInterrupts(writer);
  writer.emit(`${operation} $8, $9`);
  const branchPc = delaySlot ? writer.pc() : undefined;
  if (delaySlot) writer.emit(`beq $0, $0, _co_probe_s${id}_after_branch`);
  const victimPc = writer.pc();
  const requiredCommits: P7ProbeCommitExpectation[] = [];
  recordRead(writer, 'mflo', 10, finalPair[1], requiredCommits);
  let forbiddenCommitPcs: number[] | undefined;
  if (delaySlot) {
    forbiddenCommitPcs = [writer.pc()];
    writer.emit('sw $0, 0x628($0)');
    writer.label(`_co_probe_s${id}_after_branch`);
  }
  recordRead(writer, 'mfhi', 11, finalPair[0], requiredCommits);
  recordStore(writer, 10, resultLoAddress, finalPair[1], requiredCommits);
  recordStore(writer, 11, resultHiAddress, finalPair[0], requiredCommits);
  if (writer.pc() !== donePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 older-MDU scenario ${id} done PC was miscalculated.`);
  }
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  const expectedBd = delaySlot;
  const epc = branchPc ?? victimPc;
  return {
    ...scenarioWithLocations(id, 'external', epc, donePc),
    variant,
    victimPc,
    triggerPc: victimPc,
    expectedBd,
    allowedEpc: [epc],
    armAddress: p7ProbeExternalArmAddress,
    armValue: id,
    externalDelayCycles: 0,
    expectedRecords: [{
      expectedIpMask: expectedIpMask('external'),
      expectedExcCode: 0,
      expectedBd,
      allowedEpc: [epc],
      allowedAuxPairs: [finalPair],
      auxPairDescription: `${operation} 在被中断的 mflo 之前已完成`
    }],
    requiredPreHandlerCommits,
    requiredCommits,
    ...(forbiddenCommitPcs ? { forbiddenCommitPcs } : {}),
    requireCompletion: true
  };
}

export function emitInterruptMduScenario(
  writer: ProgramWriter,
  id: number,
  kind: InterruptKind,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  if (!isInterruptMduVariant(variant)) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported interrupt MDU probe variant ${variant}.`);
  }
  const operation = variant.slice('mdu-retry-'.length) as MduOperation;
  const finalPair = finalHiLo(operation);
  emitDisableInterrupts(writer);
  emitStoreImmediate(writer, p7ProbeFlagRecordHiLo | p7ProbeFlagRetryInterruptEpc, p7ProbeStateFlags);
  emitLoadImmediate(writer, '$8', initialHi);
  writer.emit('mthi $8');
  emitLoadImmediate(writer, '$8', initialLo);
  writer.emit('mtlo $8');
  const requiredPreHandlerCommits: P7ProbeCommitExpectation[] = [];
  recordRead(writer, 'mfhi', 14, initialHi, requiredPreHandlerCommits);
  recordRead(writer, 'mflo', 15, initialLo, requiredPreHandlerCommits);
  emitLoadImmediate(writer, '$8', operand);
  emitLoadImmediate(writer, '$9', 3);

  const pending = kind === 'external' ? undefined : emitTimerPendingSetup(writer, id, kind);
  requiredPreHandlerCommits.push(...(pending?.requiredPreHandlerCommits ?? []));
  // The handler retries EPC. Its done-PC fallback still points at the actual completion
  // marker, and four separate public commits expose the result after the retry.
  const triggerInstructionCount = kind === 'external' ? 4 : pendingTimerReleaseInstructionCount;
  const victimPc = writer.pc() + (2 + triggerInstructionCount) * 4;
  const donePc = victimPc + 5 * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  if (kind === 'external') {
    emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
    emitEnableInterrupts(writer);
  } else {
    emitPendingTimerRelease(writer, victimPc);
  }
  writer.emit(operation === 'mthi' || operation === 'mtlo'
    ? `${operation} $8`
    : `${operation} $8, $9`);

  const requiredCommits: P7ProbeCommitExpectation[] = [];
  recordRead(writer, 'mfhi', 10, finalPair[0], requiredCommits);
  recordRead(writer, 'mflo', 11, finalPair[1], requiredCommits);
  recordStore(writer, 10, resultHiAddress, finalPair[0], requiredCommits);
  recordStore(writer, 11, resultLoAddress, finalPair[1], requiredCommits);
  if (writer.pc() !== donePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 MDU scenario ${id} return PC was miscalculated.`);
  }
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);

  return {
    ...scenarioWithLocations(id, kind, victimPc, donePc),
    variant,
    victimPc,
    expectedBd: false,
    allowedEpc: [victimPc],
    ...(kind === 'external' ? {
      armAddress: p7ProbeExternalArmAddress,
      armValue: id,
      externalDelayCycles: 0
    } : { timerPreset: pending!.timerPreset }),
    expectedRecords: [{
      expectedIpMask: expectedIpMask(kind),
      expectedExcCode: 0,
      expectedBd: false,
      allowedEpc: [victimPc],
      // P7 permits a victim which has already changed MDU state to finish. Public
      // HI/LO reads cannot distinguish that legal early start from a late start
      // producing the same pair; imposing one internal execution stage would be
      // unsound. Both complete pairs are legal, but torn/corrupt pairs are not.
      // mthi/mtlo also require the untouched half to retain its exact sentinel.
      allowedAuxPairs: [[initialHi, initialLo], finalPair],
      auxPairDescription: `${operation} 中断时的 HI/LO（未改变或已开始执行）`
    }],
    requiredPreHandlerCommits,
    requiredCommits,
    requireCompletion: true
  };
}

function finalHiLo(operation: MduOperation): [number, number] {
  // Frozen arithmetic vectors: -7 * 3 = -21, -7 / 3 = -2 remainder -1;
  // 4294967289 * 3 = 0x2ffffffeb, / 3 = 0x55555553 remainder 0.
  switch (operation) {
    case 'mult': return [0xffffffff, 0xffffffeb];
    case 'multu': return [2, 0xffffffeb];
    case 'div': return [0xffffffff, 0xfffffffe];
    case 'divu': return [0, 0x55555553];
    case 'mthi': return [operand, initialLo];
    case 'mtlo': return [initialHi, operand];
  }
}

function recordRead(
  writer: ProgramWriter,
  instruction: 'mfhi' | 'mflo',
  register: number,
  value: number,
  commits: P7ProbeCommitExpectation[]
): void {
  commits.push({ pc: writer.pc(), kind: 'grf', target: register, value });
  writer.emit(`${instruction} $${register}`);
}

function recordStore(
  writer: ProgramWriter,
  register: number,
  address: number,
  value: number,
  commits: P7ProbeCommitExpectation[]
): void {
  commits.push({ pc: writer.pc(), kind: 'dm', target: address, value });
  writer.emit(`sw $${register}, 0x${address.toString(16)}($0)`);
}
