import { ProgramWriter } from '../programWriter';
import { Random } from '../../random';
import {
  p7StatusEnableAllCourseInterrupts,
  p7Timer0Ctrl,
  p7Timer1Ctrl
} from './constants';

export interface ProbePaddingProfile {
  setupMax: number;
  safeMin: number;
  safeMax: number;
  postMin: number;
  postMax: number;
}

export const probeUserScratchRegisters = [
  '$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8',
  '$9', '$10', '$11', '$12', '$13', '$14', '$15',
  '$16', '$17', '$18', '$19', '$20', '$21'
] as const;

const safeDmWords = [
  0x0100, 0x0104, 0x0108, 0x010c, 0x0110, 0x0114, 0x0118, 0x011c,
  0x0200, 0x0204, 0x0208, 0x020c, 0x0210, 0x0214, 0x0218, 0x021c,
  0x0300, 0x0304, 0x0308, 0x030c, 0x0310, 0x0314, 0x0318, 0x031c
] as const;

export function paddingProfile(scenarioCount: number): ProbePaddingProfile {
  if (scenarioCount >= 56) {
    return { setupMax: 0, safeMin: 0, safeMax: 0, postMin: 0, postMax: 0 };
  }
  if (scenarioCount >= 40) {
    return { setupMax: 1, safeMin: 0, safeMax: 1, postMin: 0, postMax: 0 };
  }
  return { setupMax: 3, safeMin: 1, safeMax: 4, postMin: 1, postMax: 3 };
}

export function emitPadding(writer: ProgramWriter, rng: Random, min: number, max: number): void {
  const count = rng.int(min, Math.max(min, max));
  emitPaddingCount(writer, rng, count);
}

export function emitPaddingCount(writer: ProgramWriter, rng: Random, count: number): void {
  for (let i = 0; i < count; i++) {
    emitSafeNoiseInstruction(writer, rng);
  }
}

export function emitDisableInterrupts(writer: ProgramWriter): void {
  writer.emit('mtc0 $0, $12');
}

export function emitEnableInterrupts(writer: ProgramWriter): void {
  emitLoadImmediate(writer, '$26', p7StatusEnableAllCourseInterrupts);
  writer.emit('mtc0 $26, $12');
}

export function emitClearTimers(writer: ProgramWriter): void {
  writer.emit(`sw $0, 0x${p7Timer0Ctrl.toString(16)}($0)`);
  writer.emit(`sw $0, 0x${p7Timer1Ctrl.toString(16)}($0)`);
}

export function emitStoreImmediate(writer: ProgramWriter, value: number, address: number): void {
  emitLoadImmediate(writer, '$26', value);
  writer.emit(`sw $26, 0x${address.toString(16)}($0)`);
}

export function emitLoadImmediate(writer: ProgramWriter, register: string, value: number): void {
  const normalized = value >>> 0;
  const hi = (normalized >>> 16) & 0xffff;
  const lo = normalized & 0xffff;
  if (hi) {
    writer.emit(`lui ${register}, 0x${hi.toString(16)}`);
    if (lo) {
      writer.emit(`ori ${register}, ${register}, 0x${lo.toString(16)}`);
    }
  } else {
    writer.emit(`ori ${register}, $0, 0x${lo.toString(16)}`);
  }
}

function emitSafeNoiseInstruction(writer: ProgramWriter, rng: Random): void {
  const register = rng.pick(probeUserScratchRegisters);
  const choice = rng.int(0, 5);
  if (choice === 0) {
    writer.emit(`lui ${register}, 0x${rng.int(0, 0xffff).toString(16)}`);
  } else if (choice === 1) {
    writer.emit(`andi ${register}, ${register}, 0x${rng.int(0, 0xffff).toString(16)}`);
  } else if (choice === 2) {
    const address = rng.pick(safeDmWords);
    writer.emit(`sw ${register}, 0x${address.toString(16)}($0)`);
  } else if (choice === 3) {
    const address = rng.pick(safeDmWords);
    writer.emit(`lw ${register}, 0x${address.toString(16)}($0)`);
  } else {
    writer.emit(`ori ${register}, $0, 0x${rng.int(0, 0xffff).toString(16)}`);
  }
}
