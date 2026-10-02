// @index mips-core — Seedable java.util.Random-compatible integer syscall streams
const multiplier = 0x5deece66dn;
const mask = (1n << 48n) - 1n;

export class MarsRandomStreams {
  private readonly seeds = new Map<number, bigint>();

  seed(id: number, seed: number): void {
    this.seeds.set(id, (BigInt(seed | 0) ^ multiplier) & mask);
  }

  private bits(id: number, count: number): number {
    // A fixed initial seed makes unsupplied streams reproducible across runs.
    if (!this.seeds.has(id)) { this.seed(id, 0); }
    const next = (this.seeds.get(id)! * multiplier + 11n) & mask;
    this.seeds.set(id, next);
    return Number(next >> BigInt(48 - count));
  }

  integer(id: number): number { return this.bits(id, 32) | 0; }
  single(id: number): number { return this.bits(id, 24) / (1 << 24); }
  double(id: number): number {
    return (this.bits(id, 26) * 0x8000000 + this.bits(id, 27)) / 0x20000000000000;
  }

  bounded(id: number, bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0x7fffffff) {
      throw new Error('Random integer upper bound must be positive');
    }
    if ((bound & -bound) === bound) {
      return Number((BigInt(bound) * BigInt(this.bits(id, 31))) >> 31n);
    }
    let bits: number;
    let value: number;
    do { bits = this.bits(id, 31); value = bits % bound; }
    while (((bits - value + bound - 1) | 0) < 0);
    return value;
  }
}
