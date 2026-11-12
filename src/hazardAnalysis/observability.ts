// @index hazard-observability — Side-effect-free single-consumer counterfactuals, separate from course value validity.
import type { MemoryAccessRequest, PreparedMemoryAccess } from '../mips/core/machine/memoryBus';
import { MemoryBus } from '../mips/core/machine/memoryBus';
import type { MachineState } from '../mips/core/machine/state';
import { evaluateInstruction, InstructionEffect } from '../mips/core/machine/transition';
import { CourseExecutionProfile, isDeviceRegion, regionForAddress } from '../mips/core/profiles/profile';
import type { HazardCounterfactual } from './hazardPipeline';
import type { HazardObservability } from './reportTypes';

const supported = new Set([
  'nop', 'add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu',
  'sll', 'srl', 'sra', 'sllv', 'srlv', 'srav', 'addi', 'addiu', 'andi', 'ori', 'xori', 'slti', 'sltiu', 'lui',
  'lw', 'lh', 'lhu', 'lb', 'lbu', 'sw', 'sh', 'sb', 'lwl', 'lwr', 'swl', 'swr',
  'beq', 'bne', 'bgez', 'bgtz', 'blez', 'bltz', 'j', 'jal', 'jr', 'jalr',
  'mfhi', 'mflo', 'mthi', 'mtlo', 'mult', 'multu', 'div', 'divu'
]);
const layers = ['required', 'commonExtensions', 'marsCompatibility'] as const;
const key = (item: HazardCounterfactual): string => `${item.role ?? item.half}:${item.value >>> 0}`;

/** Recover a discarded $0 write without issuing a device transaction. */
export function discardedHazardWriteValue(
  profile: CourseExecutionProfile, state: MachineState, memory: MemoryBus, word: number
): number | undefined {
  try {
    return evaluateInstruction({ profile, state, memory: ramOnlyMemory(memory, profile, word),
      scope: { profile: profile.id, enabledLayers: layers }, undefinedBehavior: 'fail-closed' })
      .gprWrites.find((write) => write.register === 0)?.value;
  } catch { return undefined; }
}

/**
 * Prepare ALL assessments before the actual step, while RAM still holds its old
 * values. Only one source port (or one HI/LO half) changes. This measures the
 * current instruction's architectural effect, never a whole-program detection
 * rate. Unimplemented instructions, device transactions and undefined
 * counterfactuals stay unknown. No transaction is committed or aborted here.
 */
export function prepareHazardAssessment(
  profile: CourseExecutionProfile, state: MachineState, memory: MemoryBus,
  word: number, mnemonic: string, alternatives: readonly HazardCounterfactual[]
): (alternative: HazardCounterfactual) => HazardObservability {
  const results = new Map<string, HazardObservability>();
  if (!alternatives.length || !supported.has(mnemonic)) return () => 'unknown';
  const registers = state.gpr.toArray();
  const captured = Object.assign(Object.create(Object.getPrototypeOf(state)) as MachineState, state);
  const ram = ramOnlyMemory(memory, profile, word);
  const evaluate = (alternative?: HazardCounterfactual): InstructionEffect => {
    const shadow = Object.assign(Object.create(Object.getPrototypeOf(captured)) as MachineState, captured);
    let port = 0;
    Object.defineProperty(shadow, 'gpr', { value: {
      // The shared evaluator reads rs and rt once, in that order, even when both
      // fields name the same GPR. Replacing a register wholesale would mutate both.
      read: (index: number) => {
        const role = port++ === 0 ? 'rs' : 'rt';
        return alternative?.role === role ? alternative.value >>> 0 : registers[index & 31];
      }
    } });
    if (alternative?.half === 'hi') shadow.hi = alternative.value >>> 0;
    if (alternative?.half === 'lo') shadow.lo = alternative.value >>> 0;
    return evaluateInstruction({ profile, state: shadow, memory: ram,
      scope: { profile: profile.id, enabledLayers: layers }, undefinedBehavior: 'fail-closed' });
  };
  try {
    const normal = effectSignature(evaluate());
    for (const alternative of alternatives) {
      if (results.has(key(alternative))) continue;
      try {
        const changed = effectSignature(evaluate(alternative));
        results.set(key(alternative), normal === undefined || changed === undefined ? 'unknown'
          : normal === changed ? 'masked' : 'observable');
      } catch { results.set(key(alternative), 'unknown'); }
    }
  } catch { return () => 'unknown'; }
  return (alternative) => results.get(key(alternative)) ?? 'unknown';
}

/** RAM methods are read-only; device prepare/read is never delegated to the live bus. */
function ramOnlyMemory(memory: MemoryBus, profile: CourseExecutionProfile, word: number): MemoryBus {
  const ram = Object.create(memory) as MemoryBus;
  const check = (prepared: PreparedMemoryAccess): void => {
    if (prepared.device || prepared.region !== 'data') throw new Error('Counterfactual is outside ordinary RAM');
  };
  ram.fetch = () => ({ word });
  ram.prepare = (request: MemoryAccessRequest) => {
    const region = regionForAddress(profile, request.address >>> 0);
    if (region && isDeviceRegion(region)) throw new Error('Counterfactual device transaction');
    return memory.prepare(request);
  };
  ram.readWord = (prepared) => { check(prepared); return memory.readWord(prepared); };
  ram.read = (prepared, signExtend) => { check(prepared); return MemoryBus.prototype.read.call(ram, prepared, signExtend); };
  ram.storePreview = (prepared, value) => { check(prepared); return MemoryBus.prototype.storePreview.call(ram, prepared, value); };
  ram.commit = () => { throw new Error('Counterfactual cannot commit'); };
  return ram;
}

function effectSignature(effect: InstructionEffect): string | undefined {
  if (effect.outOfDomain || effect.deviceAccess || effect.extensionCommit) return undefined;
  // Loads have no RAM side effect. Store address/mask and selected bytes are
  // observable transactions, even when the merged word remains unchanged.
  const store = effect.store;
  return JSON.stringify({
    gpr: effect.gprWrites.filter((write) => write.register !== 0), hiLo: effect.hiLoWrites,
    nextPc: effect.nextPc, pendingPc: effect.pendingBranch?.targetPc,
    controlTarget: effect.controlTarget,
    store: store && { address: store.prepared.address, width: store.prepared.width,
      mask: store.prepared.byteMask, value: store.valueAfter },
    exception: effect.exception && { name: effect.exception.name, address: effect.exception.address }
  });
}
