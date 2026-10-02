// @index mips-core — Ordinary MARS instruction extensions composed around the shared CPU
import { InstructionExtension } from '../machine/transition';
import { floatingPointExtension } from './floatingPoint';
import { FloatingPointState } from './floatingPointState';

export function marsInstructionExtension(fpu: FloatingPointState): InstructionExtension {
  const floatingPoint = floatingPointExtension(fpu);
  return (context, instruction) => {
    const word = instruction.word;
    if (((word & 0xfc00003f) >>> 0) === 0x0000000d) {
      return { ...instruction, mnemonic: 'break', exception: {
        name: 'bp', stage: 'decode', message: 'Breakpoint exception (break instruction)'
      } };
    }
    // Integer movf/movt instructions consume a COP1 condition flag.
    if (((word & 0xfc00003f) >>> 0) === 1) {
      const condition = (word >>> 18) & 7;
      const onTrue = ((word >>> 16) & 1) !== 0;
      const rs = (word >>> 21) & 31;
      const rd = (word >>> 11) & 31;
      return { ...instruction, mnemonic: onTrue ? 'movt' : 'movf',
        gprWrites: fpu.condition(condition) === onTrue
          ? [{ register: rd, value: context.state.gpr.read(rs) }] : [] };
    }
    return floatingPoint(context, instruction);
  };
}
