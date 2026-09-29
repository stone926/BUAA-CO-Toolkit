// @index control-target-coverage — Bounded bidirectional branch graph with observable path witnesses
import { CpuState } from '../cpuState';

/** The random generator owns instruction accounting and dynamic hazard observation. */
export interface ControlTargetWriter {
  readonly allowed: ReadonlySet<string>;
  readonly state: CpuState;
  remaining(): number;
  usesDelaySlot(): boolean;
  emit(mnemonic: string, text: string): void;
  label(name: string): void;
  nextLabel(prefix: string): string;
  skippedPoison(skipped: boolean): void;
  beginControlRegion(): void;
  endControlRegion(): void;
}

const required = ['ori', 'sub', 'beq', 'nop'];

export function emitControlTargetCoverage(writer: ControlTargetWriter): void {
  if (!required.every((mnemonic) => writer.allowed.has(mnemonic))) return;
  const delay = writer.usesDelaySlot();
  if (writer.remaining() >= 17 + (delay ? 6 : 0)) {
    writer.beginControlRegion();
    try { emitBranchGraph(writer, delay); } finally { writer.endControlRegion(); }
  } else if (writer.remaining() >= (delay ? 12 : 9)) {
    writer.beginControlRegion();
    try { emitCompactLoop(writer, delay); } finally { writer.endControlRegion(); }
  }
}

/** The compact witness retains coverage for short instruction budgets. */
function emitCompactLoop(writer: ControlTargetWriter, delay: boolean): void {
  const self = writer.nextLabel('self');
  const back = writer.nextLabel('backward');
  const done = writer.nextLabel('backward_done');
  writer.emit('ori', 'ori $22, $0, 1');
  writer.emit('ori', 'ori $21, $0, 2');
  writer.label(self);
  writer.emit('beq', `beq $0, $22, ${self}`);
  if (delay) writer.emit('nop', 'nop');
  writer.skippedPoison(false);
  writer.label(back);
  writer.emit('sub', 'sub $21, $21, $22');
  writer.emit('beq', `beq $21, $0, ${done}`);
  if (delay) writer.emit('nop', 'nop');
  writer.skippedPoison(false);
  writer.emit('beq', `beq $0, $0, ${back}`);
  if (delay) writer.emit('nop', 'nop');
  writer.skippedPoison(true);
  writer.label(done);
  writer.state.setRegister('$22', 1);
  writer.state.setRegister('$21', 0);
}

/**
 * Three visits to a low address: the first takes a forward path to the lower arm,
 * the second takes the higher arm, and the third exits. Each arm has a distinct
 * architectural write; wrong jumps also expose the skipped poison write.
 */
function emitBranchGraph(writer: ControlTargetWriter, delay: boolean): void {
  const self = writer.nextLabel('self');
  const back = writer.nextLabel('backward');
  const high = writer.nextLabel('forward_high');
  const middle = writer.nextLabel('forward_middle');
  const join = writer.nextLabel('branch_join');
  const done = writer.nextLabel('backward_done');
  const put = (mnemonic: string, instruction: string): void => writer.emit(mnemonic, instruction);
  const slot = (): void => { if (delay) put('nop', 'nop'); };

  put('ori', 'ori $22, $0, 1');
  writer.state.setRegister('$22', 1);
  put('ori', 'ori $21, $0, 3');
  writer.state.setRegister('$21', 3);
  writer.label(self);
  put('beq', `beq $0, $22, ${self}`);
  slot();
  put('ori', 'ori $20, $0, 0x40');
  writer.state.setRegister('$20', 0x40);

  writer.label(back);
  put('sub', 'sub $21, $21, $22');
  writer.state.setRegister('$21', 2);
  put('beq', `beq $21, $0, ${done}`);
  slot();
  put('beq', `beq $21, $22, ${high}`);
  slot();
  put('beq', `beq $0, $0, ${middle}`);
  slot();
  put('ori', 'ori $26, $0, 0x71');

  writer.label(high);
  put('ori', 'ori $20, $0, 0x52');
  writer.state.setRegister('$20', 0x52);
  put('beq', `beq $0, $0, ${join}`);
  slot();
  put('ori', 'ori $26, $0, 0x72');

  writer.label(middle);
  put('ori', 'ori $20, $0, 0x51');
  writer.state.setRegister('$20', 0x51);
  writer.label(join);
  put('ori', 'ori $23, $21, 0');
  writer.state.setRegister('$23', 2);
  put('beq', `beq $0, $0, ${back}`);
  slot();
  put('ori', 'ori $26, $0, 0x73');

  writer.label(done);
  put('ori', 'ori $20, $0, 0x53');
  writer.state.setRegister('$20', 0x53);
  writer.state.setRegister('$21', 0);
  writer.state.setRegister('$23', 1);
}
