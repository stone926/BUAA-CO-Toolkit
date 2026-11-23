// @index p7-probe — Physical IM bounds, vector fall-through, and fetch fault precedence
import { p7RiWordCatalog, p7RiWordDirective } from '../../p7RiWords';
import { ProgramWriter } from '../programWriter';
import type { BuiltinAsmGeneratorOptions, BuiltinAsmGeneratorResult } from '../randomBody';
import type { P7ProbeCommitExpectation } from '../types';
import { p7ExceptionHandlerAddress, p7Hex, p7KernelTextDumpEndAddress, p7UserTextBaseAddress } from './constants';
import { DirectedProbeProgram, expectRegister, expectStore } from './directedProbeProgram';

export function generateP7InstructionBoundaryProbe(options: BuiltinAsmGeneratorOptions): BuiltinAsmGeneratorResult {
  const program = new DirectedProbeProgram(options, 'im-boundaries');
  const { main } = program;
  main.emit('addi $15, $15, 1');
  main.emit('bne $14, $0, _co_boundary_low_returned');
  main.emit('nop');
  program.observeResetCp0();
  main.emit('ori $14, $0, 1');
  main.emit(`ori $12, $0, ${p7Hex(p7UserTextBaseAddress)}`);
  main.emit('jr $12');
  main.emit('nop');
  main.label('_co_boundary_low_returned');
  const low = expectStore(main, 'sw $15, 0x630($0)', 0x630, 2);
  main.emit('beq $0, $0, _co_boundary_before_vector');
  main.emit('nop');
  main.label('_co_boundary_after_vector');

  const beforeVector = new ProgramWriter(p7ExceptionHandlerAddress - 4);
  beforeVector.raw(`.text ${p7Hex(beforeVector.pc())}`);
  beforeVector.label('_co_boundary_before_vector');
  const vectorPredecessor = expectRegister(beforeVector, 'ori $11, $0, 0x417c', 11, p7ExceptionHandlerAddress - 4);

  const handler = program.handler('_co_boundary_natural_entry');
  handler.label('_co_boundary_natural_entry');
  const naturalStatus = expectStore(handler, 'sw $24, 0x634($0)', 0x634, 0);
  const naturalControl = expectStore(handler, 'sw $11, 0x638($0)', 0x638, p7ExceptionHandlerAddress - 4);
  handler.emit('mfc0 $24, $13');
  const naturalCause = expectStore(handler, 'sw $24, 0x63c($0)', 0x63c, 0);
  handler.emit('mfc0 $24, $14');
  const naturalEpc = expectStore(handler, 'sw $24, 0x640($0)', 0x640, 0);
  handler.emit('beq $0, $0, _co_boundary_after_vector');
  handler.emit('nop');

  const upper = new ProgramWriter(p7KernelTextDumpEndAddress);
  upper.raw(`.text ${p7Hex(upper.pc())}`);
  const last = expectRegister(upper, 'ori $13, $0, 0x6ffc', 13, p7KernelTextDumpEndAddress);
  emitFetchFault(program, 'im-upper-bound', p7KernelTextDumpEndAddress, p7KernelTextDumpEndAddress + 4,
    [low, vectorPredecessor, naturalStatus, naturalControl, naturalCause, naturalEpc, last]);
  emitFetchFault(program, 'im-below-lower-bound', p7UserTextBaseAddress - 4);

  const cells = new ProgramWriter(0x4000);
  cells.raw(`.text ${p7Hex(cells.pc())}`);
  for (const [wordKind, instruction] of [
    ['syscall', 'syscall'], ...p7RiWordCatalog.map(entry => [entry.variant, p7RiWordDirective(entry)])
  ]) {
    const aligned = cells.pc();
    cells.emit(instruction);
    for (const offset of [1, 2, 3]) {
      // The public course TB indexes IM by word, so these three misaligned byte addresses
      // present the real aligned instruction word on the bus. Fetch AdEL must outrank it.
      emitFetchFault(program, `fetch-misaligned-${wordKind}-${offset}`, aligned + offset);
    }
  }
  return program.finish(cells, beforeVector, handler, upper);
}

function emitFetchFault(
  program: DirectedProbeProgram, variant: string, targetPc: number, victimPc = targetPc,
  requiredPreHandlerCommits?: P7ProbeCommitExpectation[]
): void {
  const item = program.next('adel', variant);
  const { main } = program;
  program.prepare(item);
  main.emit(`ori $12, $0, ${p7Hex(targetPc)}`);
  main.emit('jr $12');
  main.emit('nop');
  const poisonPc = main.pc();
  main.emit('sw $12, 0x624($0)');
  program.complete(item, { statusBeforeException: 0, allowedEpc: [victimPc], victimPc,
    bd: false, ...(requiredPreHandlerCommits ? { requiredPreHandlerCommits } : {}), forbiddenCommitPcs: [poisonPc] });
}
