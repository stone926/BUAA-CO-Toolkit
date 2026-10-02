// @index mips-core — MARS COP1 raw registers, little-endian double pairs, and condition flags
export interface FloatingPointWrite { readonly register: number; readonly value: number; }

export class FloatingPointState {
  private readonly words = new Uint32Array(32);
  private readonly view = new DataView(new ArrayBuffer(8));
  private conditions = 0;

  raw(register: number): number { return this.words[register & 31]; }
  condition(flag: number): boolean { return ((this.conditions >>> flag) & 1) !== 0; }
  get conditionFlags(): number { return this.conditions; }
  snapshot(): readonly number[] { return Array.from(this.words); }

  single(register: number): number {
    this.view.setUint32(0, this.raw(register), true);
    return this.view.getFloat32(0, true);
  }

  double(register: number): number {
    this.requirePair(register);
    this.view.setUint32(0, this.raw(register), true);
    this.view.setUint32(4, this.raw(register + 1), true);
    return this.view.getFloat64(0, true);
  }

  requirePair(register: number): void {
    if ((register & 1) !== 0 || register < 0 || register > 30) {
      throw new Error('Double-precision floating-point registers must be even-numbered');
    }
  }

  singleWrites(register: number, value: number): readonly FloatingPointWrite[] {
    this.view.setFloat32(0, value, true);
    return [{ register, value: Number.isNaN(value) ? 0x7fc00000 : this.view.getUint32(0, true) }];
  }

  doubleWrites(register: number, value: number): readonly FloatingPointWrite[] {
    this.requirePair(register);
    this.view.setFloat64(0, value, true);
    return [
      { register, value: Number.isNaN(value) ? 0 : this.view.getUint32(0, true) },
      { register: register + 1, value: Number.isNaN(value) ? 0x7ff80000 : this.view.getUint32(4, true) }
    ];
  }

  commit(writes: readonly FloatingPointWrite[]): void {
    for (const write of writes) { this.words[write.register & 31] = write.value >>> 0; }
  }

  setCondition(flag: number, value: boolean): void {
    this.conditions = value ? this.conditions | (1 << flag) : this.conditions & ~(1 << flag);
  }
}
