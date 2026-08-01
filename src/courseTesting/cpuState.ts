/** Course DM range is 0x0000..0x2fff for P3-P7. */
export const courseDataByteLength = 0x3000;
const dataWordCount = courseDataByteLength / 4;

/**
 * Software model of the MIPS CPU state used by the built-in ASM generator.
 * Tracks GPRs, data memory, HI/LO, CP0 registers, and MDU protection state.
 */
export class CpuState {
  readonly regs = new Map<string, number>();
  readonly memory = new Map<number, number>();
  readonly recentWrites: string[] = [];
  hi = 0;
  lo = 0;
  hiInitialized = false;
  loInitialized = false;
  pendingHiLoRead = false;
  mduProtectedSlots = 0;
  cp0_sr = 0;
  cp0_cause = 0;
  cp0_epc = 0;

  constructor() {
    for (let i = 0; i <= 31; i++) {
      this.regs.set(`$${i}`, 0);
    }
    for (let i = 0; i < dataWordCount; i++) {
      this.memory.set(i * 4, 0);
    }
  }

  setRegister(register: string, value: number): void {
    if (register === '$0') {
      this.regs.set('$0', 0);
      return;
    }
    const normalized = (value | 0);
    this.regs.set(register, normalized);
    this.recentWrites.unshift(register);
    while (this.recentWrites.length > 8) {
      this.recentWrites.pop();
    }
  }

  regValue(register: string): number {
    return this.regs.get(register) ?? 0;
  }

  wordAt(address: number): number {
    return this.memory.get(address & ~3) ?? 0;
  }

  halfAt(address: number): number {
    return this.byteAt(address) | (this.byteAt(address + 1) << 8);
  }

  byteAt(address: number): number {
    const word = this.wordAt(address);
    const shift = (address & 3) * 8;
    return (word >>> shift) & 0xff;
  }

  writeByte(address: number, value: number): void {
    const aligned = address & ~3;
    const shift = (address & 3) * 8;
    const mask = ~(0xff << shift);
    const previous = this.wordAt(aligned);
    this.memory.set(aligned, (previous & mask) | ((value & 0xff) << shift));
  }

  /** MARS/BUAA little-endian LWL merge semantics. */
  loadWordLeft(address: number, previous: number): number {
    let result = previous | 0;
    for (let i = 0; i <= (address & 3); i++) {
      result = setByte(result, 3 - i, this.byteAt(address - i));
    }
    return result | 0;
  }

  /** MARS/BUAA little-endian LWR merge semantics. */
  loadWordRight(address: number, previous: number): number {
    let result = previous | 0;
    for (let i = 0; i <= 3 - (address & 3); i++) {
      result = setByte(result, i, this.byteAt(address + i));
    }
    return result | 0;
  }

  /** MARS/BUAA little-endian SWL partial-store semantics. */
  storeWordLeft(address: number, value: number): void {
    for (let i = 0; i <= (address & 3); i++) {
      this.writeByte(address - i, byteAt(value, 3 - i));
    }
  }

  /** MARS/BUAA little-endian SWR partial-store semantics. */
  storeWordRight(address: number, value: number): void {
    for (let i = 0; i <= 3 - (address & 3); i++) {
      this.writeByte(address + i, byteAt(value, i));
    }
  }

  cp0ReadValue(cp0Register: string): number {
    switch (cp0Register) {
      case '$12':
        return this.cp0_sr;
      case '$13':
        return this.cp0_cause;
      case '$14':
        return this.cp0_epc;
      default:
        return 0;
    }
  }

  cp0WriteValue(cp0Register: string, value: number): void {
    const normalized = (value | 0);
    switch (cp0Register) {
      case '$12':
        this.cp0_sr = normalized;
        break;
      case '$14':
        this.cp0_epc = normalized;
        break;
    }
  }

  armMduProtection(busyCycles: number): void {
    this.mduProtectedSlots = Math.max(this.mduProtectedSlots, busyCycles + 1);
  }
}

function byteAt(value: number, index: number): number {
  return (value >>> (index * 8)) & 0xff;
}

function setByte(value: number, index: number, byte: number): number {
  const shift = index * 8;
  const mask = ~(0xff << shift);
  return (value & mask) | ((byte & 0xff) << shift);
}
