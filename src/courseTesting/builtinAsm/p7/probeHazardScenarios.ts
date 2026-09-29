// @index p7-probe-hazards — Architectural exception/interrupt replay through load-use and delay-slot hazards
import { ProgramWriter } from '../programWriter';
import { P7ProbeCommitExpectation, P7ProbeScenario, P7ProbeScenarioKind } from '../types';
import { BuiltinAsmGeneratorError } from '../randomBody';
import { emitEnableInterrupts, emitLoadImmediate, emitStoreImmediate } from './probeAsm';
import {
  p7ProbeExternalArmAddress, p7ProbeFlagRetryInterruptEpc, p7ProbeStateDonePc, p7ProbeStateFlags
} from './constants';
import { emitPendingTimerRelease, emitTimerPendingSetup, pendingTimerReleaseInstructionCount } from './probePriorityScenarios';
import { expectedExcCode, expectedIpMask, scenarioWithLocations } from './probeScenarios';

const sourceAddress = 0x0640;
const resultAddress = 0x0644;
const poisonAddress = 0x0648;
const sourceValue = 0x39;

/**
 * Use only architectural PCs and observable writes. A load-use dependency may
 * stall in different stages (or be forwarded without a stall); no expected
 * cycle count or internal bubble signal is used. External requests target the
 * public macroscopic PC. Timers use stable pending requests, and eret replays
 * the whole dependency window after the interrupt is acknowledged.
 */
export function emitHazardScenario(
  writer: ProgramWriter, id: number, kind: P7ProbeScenarioKind, variant: string
): P7ProbeScenario {
  if (kind === 'external' || kind === 'timer0' || kind === 'timer1') {
    return emitInterruptHazard(writer, id, kind, variant);
  }
  if (kind === 'adel' || kind === 'ades' || kind === 'ov') {
    return emitExceptionHazard(writer, id, kind, variant);
  }
  throw new BuiltinAsmGeneratorError(`Unsupported P7 hazard scenario ${kind}/${variant}.`);
}

function emitInterruptHazard(
  writer: ProgramWriter, id: number, kind: 'external' | 'timer0' | 'timer1', variant: string
): P7ProbeScenario {
  const delayLoad = variant === 'hazard-delay-load-use';
  const indirectJump = variant === 'hazard-load-jr';
  const victimIsProducer = variant === 'hazard-load-younger-branch';
  const taken = variant !== 'hazard-load-branch-not-taken';
  const doneLabel = `_co_probe_s${id}_done`;
  const targetLabel = `_co_probe_s${id}_hazard_target`;
  emitStoreImmediate(writer, p7ProbeFlagRetryInterruptEpc, p7ProbeStateFlags);
  const pending = kind === 'external' ? undefined : emitTimerPendingSetup(writer, id, kind);
  const pre: P7ProbeCommitExpectation[] = [...(pending?.requiredPreHandlerCommits ?? [])];
  const post: P7ProbeCommitExpectation[] = [];
  const forbiddenCommitPcs: number[] = [];
  const releaseLength = kind === 'external' ? 4 : pendingTimerReleaseInstructionCount;
  // Three setup instructions, two for done-PC, then the source-specific release.
  const entryPc = writer.pc() + (3 + 2 + releaseLength) * 4;
  const donePc = entryPc + (delayLoad ? 4 : 7) * 4;
  const value = indirectJump ? entryPc + 6 * 4 : sourceValue;
  emitLoadImmediate(writer, '$9', value);
  emitCommit(writer, `sw $9, ${sourceAddress}($0)`, 'dm', sourceAddress, value, pre);
  // Poison the old operand/target. Omitting load forwarding must change the
  // branch result or execute the independently forbidden wrong-path store.
  emitLoadImmediate(writer, '$8', indirectJump ? entryPc + 3 * 4 : sourceValue ^ 0xffff);
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  if (kind === 'external') {
    emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
    emitEnableInterrupts(writer);
  } else {
    emitPendingTimerRelease(writer, entryPc);
  }
  assertPc(writer, entryPc);

  const externalVictimPc = entryPc + (victimIsProducer ? 0 : 4);
  const victimPc = kind === 'external' ? externalVictimPc : entryPc;
  const bd = kind === 'external' && delayLoad;
  const epc = bd ? entryPc : victimPc;
  if (delayLoad) {
    writer.emit(`beq $0, $0, ${targetLabel}`);
    emitCommit(writer, `lw $8, ${sourceAddress}($0)`, 'grf', 8, value, post);
    writer.label(targetLabel);
    emitCommit(writer, 'add $10, $8, $9', 'grf', 10, value * 2, post);
    emitCommit(writer, `sw $10, ${resultAddress}($0)`, 'dm', resultAddress, value * 2, post);
  } else {
    emitCommit(writer, `lw $8, ${sourceAddress}($0)`, 'grf', 8, value,
      kind === 'external' && !victimIsProducer ? pre : post);
    writer.emit(indirectJump ? 'jr $8' : `${taken ? 'beq' : 'bne'} $8, $9, ${targetLabel}`);
    const resultValue = indirectJump ? value : value * 2;
    emitCommit(writer, indirectJump ? 'add $10, $9, $0' : 'add $10, $8, $9', 'grf', 10, resultValue, post);
    emitPathStore(!taken, resultValue);
    writer.emit(`beq $0, $0, ${doneLabel}`);
    writer.emit('nop');
    writer.label(targetLabel);
    emitPathStore(taken, resultValue);
  }
  assertPc(writer, donePc);
  writer.label(doneLabel);
  writer.emit(`ori $1, $0, ${id}`);
  return {
    ...scenarioWithLocations(id, kind, victimPc, donePc),
    variant, victimPc, expectedBd: bd, allowedEpc: [epc],
    ...(kind === 'external' ? {
      triggerPc: victimPc,
      armAddress: p7ProbeExternalArmAddress, armValue: id, externalDelayCycles: 0
    } : { timerPreset: pending!.timerPreset }),
    expectedRecords: [{
      expectedIpMask: expectedIpMask(kind), expectedExcCode: 0, expectedBd: bd, allowedEpc: [epc],
      // Mode 0 has already expired; the handler samples CTRL/COUNT before clear.
      allowedAuxPairs: [kind === 'external' ? [0, 0] : [8, 0]],
      auxPairDescription: `${kind} 中断源稳定时的 CTRL/COUNT`
    }],
    requiredPreHandlerCommits: pre, requiredCommits: post, forbiddenCommitPcs, requireCompletion: true
  };

  function emitPathStore(correct: boolean, resultValue: number): void {
    if (correct) {
      emitCommit(writer, `sw $10, ${resultAddress}($0)`, 'dm', resultAddress, resultValue, post);
    } else {
      forbiddenCommitPcs.push(writer.pc());
      writer.emit(`sw $0, ${poisonAddress}($0)`);
    }
  }
}

function emitExceptionHazard(
  writer: ProgramWriter, id: number, kind: 'adel' | 'ades' | 'ov', variant: string
): P7ProbeScenario {
  const delayed = variant.startsWith('hazard-delay-');
  const doneLabel = `_co_probe_s${id}_done`;
  const value = kind === 'ov' ? 0x7fffffff : 1;
  const pre: P7ProbeCommitExpectation[] = [];
  const forbiddenCommitPcs: number[] = [];
  emitEnableInterrupts(writer);
  emitLoadImmediate(writer, '$9', value);
  emitCommit(writer, `sw $9, ${sourceAddress}($0)`, 'dm', sourceAddress, value, pre);
  emitLoadImmediate(writer, '$9', 1);
  emitLoadImmediate(writer, '$8', 0); // stale forwarding would suppress the intended exception
  const donePc = writer.pc() + (2 + 1 + (delayed ? 1 : 0) + 1 + 3) * 4;
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  emitCommit(writer, `lw $8, ${sourceAddress}($0)`, 'grf', 8, value, pre);
  const epc = writer.pc();
  if (delayed) {
    // AdEL/AdES take the branch, Ov does not. BD must survive either outcome,
    // including any bubbles introduced by the immediately preceding load.
    writer.emit(`beq $8, $9, ${doneLabel}`);
  }
  const victimPc = writer.pc();
  writer.emit(kind === 'adel' ? 'lw $10, 0($8)'
    : kind === 'ades' ? 'sw $9, 0($8)' : 'add $10, $8, $9');
  // The fault is older than this load-use chain. Req must cancel its writes
  // despite younger dependency stalls; a later overwrite cannot hide a leak.
  for (const instruction of [
    `lw $10, ${sourceAddress}($0)`, 'add $11, $10, $9', `sw $11, ${poisonAddress}($0)`
  ]) {
    forbiddenCommitPcs.push(writer.pc());
    writer.emit(instruction);
  }
  assertPc(writer, donePc);
  writer.label(doneLabel);
  writer.emit(`ori $1, $0, ${id}`);
  return {
    ...scenarioWithLocations(id, kind, epc, donePc),
    variant, victimPc, expectedExcCode: expectedExcCode(kind), expectedBd: delayed, allowedEpc: [epc],
    requiredPreHandlerCommits: pre, forbiddenCommitPcs, requireCompletion: true
  };
}

function emitCommit(
  writer: ProgramWriter, instruction: string, kind: 'grf' | 'dm', target: number, value: number,
  commits: P7ProbeCommitExpectation[]
): void {
  commits.push({ pc: writer.pc(), kind, target, value });
  writer.emit(instruction);
}

function assertPc(writer: ProgramWriter, expected: number): void {
  if (writer.pc() !== expected) {
    throw new BuiltinAsmGeneratorError('Internal generator error: P7 hazard scenario PC was miscalculated.');
  }
}
