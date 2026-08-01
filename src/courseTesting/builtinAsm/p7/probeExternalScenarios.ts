// @index p7-probe-external — 定向外部中断受害指令、重试路径与可见提交约束
import { ProgramWriter } from '../programWriter';
import { P7ProbeCommitExpectation, P7ProbeScenario } from '../types';
import { Random } from '../../random';
import { BuiltinAsmGeneratorError } from '../randomBody';
import {
  p7CauseIpExternalMask,
  p7ProbeExternalArmAddress,
  p7ProbeFlagRetryInterruptEpc,
  p7ProbeStateDonePc,
  p7ProbeStateFlags
} from './constants';
import {
  ProbePaddingProfile,
  emitEnableInterrupts,
  emitLoadImmediate,
  emitPadding,
  emitStoreImmediate
} from './probeAsm';
import { scenarioWithLocations } from './probeScenarios';

const retryStoreAddress = 0x0600;
const retryLoadAddress = 0x0604;
const retryDelayStoreAddress = 0x0608;
const retryStoreValue = 0x5a5a;
const retryLoadValue = 0x39;
const retryDelayStoreValue = 0x6b6b;

const retryVariants = new Set([
  'retry-store',
  'retry-load-dependency',
  'retry-jal',
  'retry-delay-slot-store'
]);

export function isExternalRetryVariant(variant: string | undefined): boolean {
  return variant !== undefined && retryVariants.has(variant);
}

export function emitExternalRetryScenario(
  writer: ProgramWriter,
  id: number,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  switch (variant) {
    case 'retry-store':
      return emitRetryStore(writer, id, variant, rng, padding);
    case 'retry-load-dependency':
      return emitRetryLoadDependency(writer, id, variant, rng, padding);
    case 'retry-jal':
      return emitRetryJal(writer, id, variant, rng, padding);
    case 'retry-delay-slot-store':
      return emitRetryDelaySlotStore(writer, id, variant, rng, padding);
    default:
      throw new BuiltinAsmGeneratorError(`Internal generator error: unsupported external retry probe variant ${variant}.`);
  }
}

function emitRetryStore(
  writer: ProgramWriter,
  id: number,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  emitLoadImmediate(writer, '$8', retryStoreValue);
  emitRetryFlag(writer);
  const donePc = writer.pc() + 7 * 4;
  emitRetryPreamble(writer, id, donePc);
  const victimPc = writer.pc();
  writer.emit(`sw $8, 0x${retryStoreAddress.toString(16)}($0)`);
  return finishRetryScenario(writer, id, variant, victimPc, donePc, false, [victimPc], rng, padding, [{
    pc: victimPc,
    kind: 'dm',
    target: retryStoreAddress,
    value: retryStoreValue
  }]);
}

function emitRetryLoadDependency(
  writer: ProgramWriter,
  id: number,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  emitLoadImmediate(writer, '$8', retryLoadValue);
  writer.emit(`sw $8, 0x${retryLoadAddress.toString(16)}($0)`);
  emitLoadImmediate(writer, '$9', retryLoadValue);
  emitRetryFlag(writer);
  const donePc = writer.pc() + 11 * 4;
  emitRetryPreamble(writer, id, donePc);
  const victimPc = writer.pc();
  writer.emit(`lw $8, 0x${retryLoadAddress.toString(16)}($0)`);
  writer.emit(`beq $8, $9, _co_probe_s${id}_done`);
  writer.emit('nop');
  writer.label(`_co_probe_s${id}_bad_dependency`);
  writer.emit(`beq $0, $0, _co_probe_s${id}_bad_dependency`);
  writer.emit('nop');
  return finishRetryScenario(writer, id, variant, victimPc, donePc, false, [victimPc], rng, padding, [{
    pc: victimPc,
    kind: 'grf',
    target: 8,
    value: retryLoadValue
  }]);
}

function emitRetryJal(
  writer: ProgramWriter,
  id: number,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  emitRetryFlag(writer);
  const donePc = writer.pc() + 10 * 4;
  emitRetryPreamble(writer, id, donePc);
  const victimPc = writer.pc();
  writer.emit(`jal _co_probe_s${id}_done`);
  writer.emit('nop');
  writer.label(`_co_probe_s${id}_bad_jal`);
  writer.emit(`beq $0, $0, _co_probe_s${id}_bad_jal`);
  writer.emit('nop');
  return finishRetryScenario(writer, id, variant, victimPc, donePc, false, [victimPc], rng, padding, [{
    pc: victimPc,
    kind: 'grf',
    target: 31,
    value: victimPc + 8
  }]);
}

function emitRetryDelaySlotStore(
  writer: ProgramWriter,
  id: number,
  variant: string,
  rng: Random,
  padding: ProbePaddingProfile
): P7ProbeScenario {
  emitLoadImmediate(writer, '$8', retryDelayStoreValue);
  emitRetryFlag(writer);
  const donePc = writer.pc() + 8 * 4;
  emitRetryPreamble(writer, id, donePc);
  const branchPc = writer.pc();
  writer.emit(`beq $0, $0, _co_probe_s${id}_done`);
  const victimPc = writer.pc();
  writer.emit(`sw $8, 0x${retryDelayStoreAddress.toString(16)}($0)`);
  return finishRetryScenario(writer, id, variant, victimPc, donePc, true, [branchPc], rng, padding, [{
    pc: victimPc,
    kind: 'dm',
    target: retryDelayStoreAddress,
    value: retryDelayStoreValue
  }]);
}

function emitRetryFlag(writer: ProgramWriter): void {
  emitStoreImmediate(writer, p7ProbeFlagRetryInterruptEpc, p7ProbeStateFlags);
}

function emitRetryPreamble(writer: ProgramWriter, id: number, donePc: number): void {
  emitStoreImmediate(writer, donePc, p7ProbeStateDonePc);
  emitStoreImmediate(writer, id, p7ProbeExternalArmAddress);
  emitEnableInterrupts(writer);
}

function finishRetryScenario(
  writer: ProgramWriter,
  id: number,
  variant: string,
  victimPc: number,
  donePc: number,
  expectedBd: boolean,
  allowedEpc: number[],
  rng: Random,
  padding: ProbePaddingProfile,
  requiredCommits: P7ProbeCommitExpectation[]
): P7ProbeScenario {
  if (writer.pc() !== donePc) {
    throw new BuiltinAsmGeneratorError(`Internal generator error: P7 external retry scenario ${id} return PC was miscalculated.`);
  }
  writer.label(`_co_probe_s${id}_done`);
  writer.emit(`ori $1, $0, ${id}`);
  emitPadding(writer, rng, padding.postMin, padding.postMax);
  return {
    ...scenarioWithLocations(id, 'external', victimPc, donePc),
    expectedIpMask: p7CauseIpExternalMask,
    expectedExcCode: 0,
    expectedBd,
    allowedEpc,
    variant,
    victimPc,
    waitPc: victimPc,
    armAddress: p7ProbeExternalArmAddress,
    armValue: id,
    externalDelayCycles: 0,
    requireCompletion: true,
    requiredCommits
  };
}
