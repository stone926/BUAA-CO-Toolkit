// @index register-coverage — Directed GPR observation and register-jump dependency coverage.
import { CpuState } from '../cpuState';

export interface RegisterCoverageWriter {
  remaining(): number;
  pc(): number;
  emit(mnemonic: string, text: string): void;
  label(label: string): void;
}

const registerObservationBase = 0x100;
const jumpTargetMemory = 0x80;

/** Every register gets a distinct, nonzero value before either GRF read port is observed. */
export function emitGeneralRegisterCoverage(
  writer: RegisterCoverageWriter,
  state: CpuState,
  allowed: ReadonlySet<string>,
  reservedInstructions = 0
): void {
  const instructionCount = 31 * 4 + 2;
  if (!['ori', 'add', 'sw'].every((mnemonic) => allowed.has(mnemonic)) ||
      writer.remaining() < instructionCount + reservedInstructions) {
    return;
  }
  writer.label('_co_gpr_coverage');
  for (let index = 1; index <= 31; index++) {
    const register = `$${index}`;
    const value = index * 0x101;
    writer.emit('ori', `ori ${register}, $0, ${value}`);
    state.setRegister(register, value);
  }
  for (let index = 1; index <= 31; index++) {
    const register = `$${index}`;
    // Identity operations exercise both read ports without clobbering another register's seed.
    // The following store propagates the last read result into a separate architectural event.
    writer.emit('add', `add ${register}, ${register}, $0`);
    writer.emit('add', `add ${register}, $0, ${register}`);
    const address = registerObservationBase + (index - 1) * 4;
    writer.emit('sw', `sw ${register}, ${address}($0)`);
    state.memory.set(address, state.regValue(register));
  }
  // $26 is the poison destination; P7's first-interrupt handler also requires $27 == 0.
  // This block executes before interrupts are enabled and never relies on either value later.
  for (const register of ['$26', '$27']) {
    writer.emit('ori', `ori ${register}, $0, 0`);
    state.setRegister(register, 0);
  }
  writer.label('_co_gpr_coverage_done');
}

/** Fixed producer -> JR/rs cases keep all 0/1/2 intervening-instruction classes reachable. */
export function emitRegisterJumpCoverage(
  writer: RegisterCoverageWriter,
  state: CpuState,
  allowed: ReadonlySet<string>,
  delaySlot: boolean
): void {
  if (!['ori', 'jr', 'nop'].every((mnemonic) => allowed.has(mnemonic))) {
    return;
  }
  const producers = ['ori', 'add', 'sub', 'lw'].filter((mnemonic) =>
    allowed.has(mnemonic) && (mnemonic !== 'lw' || allowed.has('sw')));
  const coverageInstructionCount = producers.reduce((total, producer) =>
    total + 3 * ((producer === 'ori' ? 1 : 3) + 5 + Number(delaySlot)), 0);
  // Emit the complete matrix together and retain room for the caller's selected random payload.
  if (writer.remaining() < coverageInstructionCount + Math.max(32, allowed.size * 3)) {
    return;
  }
  let caseIndex = 0;
  for (const producer of producers) {
    for (const gap of [0, 1, 2]) {
      const setupCount = producer === 'ori' ? 1 : 3;
      // setup, producer, independent gap, JR, optional delay slot, poison, target marker.
      const instructionCount = setupCount + 4 + gap + Number(delaySlot);
      if (writer.remaining() < instructionCount) {
        return;
      }
      const label = `_co_jr_${producer}_gap${gap}`;
      const targetAddress = writer.pc() + (instructionCount - 1) * 4;
      writer.label(`${label}_start`);
      const loadImmediate = (register: string, value: number): void => {
        writer.emit('ori', `ori ${register}, $0, ${value}`);
        state.setRegister(register, value);
      };
      // A stale target points at the poison instruction, yielding an extra visible write.
      loadImmediate('$25', targetAddress - 4);
      if (producer === 'ori') {
        loadImmediate('$25', targetAddress);
      } else if (producer === 'lw') {
        loadImmediate('$23', targetAddress);
        writer.emit('sw', `sw $23, ${jumpTargetMemory}($0)`);
        state.memory.set(jumpTargetMemory, targetAddress);
        writer.emit('lw', `lw $25, ${jumpTargetMemory}($0)`);
        state.setRegister('$25', targetAddress);
      } else {
        loadImmediate('$23', targetAddress + (producer === 'add' ? -4 : 4));
        loadImmediate('$24', 4);
        writer.emit(producer, `${producer} $25, $23, $24`);
        state.setRegister('$25', targetAddress);
      }
      for (let index = 0; index < gap; index++) {
        writer.emit('nop', 'nop');
      }
      writer.emit('jr', 'jr $25');
      if (delaySlot) {
        writer.emit('nop', 'nop');
      }
      writer.emit('ori', `ori $26, $0, ${0x6000 + caseIndex}`);
      writer.label(label);
      loadImmediate('$22', ++caseIndex);
    }
  }
}
