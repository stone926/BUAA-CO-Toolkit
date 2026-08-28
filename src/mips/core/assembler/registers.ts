// @index mips-core — 课程 GPR/CP0 名称表（纯 TS，与 resources/mips/registers.json 同一事实）

export interface RegisterName {
  readonly number: number;
  readonly names: readonly string[];
}

export const gprNames: readonly RegisterName[] = Object.freeze([
  { number: 0, names: Object.freeze(['$zero', '$0']) },
  { number: 1, names: Object.freeze(['$at', '$1']) },
  { number: 2, names: Object.freeze(['$v0', '$2']) },
  { number: 3, names: Object.freeze(['$v1', '$3']) },
  { number: 4, names: Object.freeze(['$a0', '$4']) },
  { number: 5, names: Object.freeze(['$a1', '$5']) },
  { number: 6, names: Object.freeze(['$a2', '$6']) },
  { number: 7, names: Object.freeze(['$a3', '$7']) },
  { number: 8, names: Object.freeze(['$t0', '$8']) },
  { number: 9, names: Object.freeze(['$t1', '$9']) },
  { number: 10, names: Object.freeze(['$t2', '$10']) },
  { number: 11, names: Object.freeze(['$t3', '$11']) },
  { number: 12, names: Object.freeze(['$t4', '$12']) },
  { number: 13, names: Object.freeze(['$t5', '$13']) },
  { number: 14, names: Object.freeze(['$t6', '$14']) },
  { number: 15, names: Object.freeze(['$t7', '$15']) },
  { number: 16, names: Object.freeze(['$s0', '$16']) },
  { number: 17, names: Object.freeze(['$s1', '$17']) },
  { number: 18, names: Object.freeze(['$s2', '$18']) },
  { number: 19, names: Object.freeze(['$s3', '$19']) },
  { number: 20, names: Object.freeze(['$s4', '$20']) },
  { number: 21, names: Object.freeze(['$s5', '$21']) },
  { number: 22, names: Object.freeze(['$s6', '$22']) },
  { number: 23, names: Object.freeze(['$s7', '$23']) },
  { number: 24, names: Object.freeze(['$t8', '$24']) },
  { number: 25, names: Object.freeze(['$t9', '$25']) },
  { number: 26, names: Object.freeze(['$k0', '$26']) },
  { number: 27, names: Object.freeze(['$k1', '$27']) },
  { number: 28, names: Object.freeze(['$gp', '$28']) },
  { number: 29, names: Object.freeze(['$sp', '$29']) },
  { number: 30, names: Object.freeze(['$fp', '$s8', '$30']) },
  { number: 31, names: Object.freeze(['$ra', '$31']) }
]);

const gprByToken = new Map<string, number>();
for (const register of gprNames) {
  for (const name of register.names) {
    gprByToken.set(name.toLowerCase(), register.number);
  }
}

export function parseGprRegister(text: string): number | undefined {
  const token = text.trim().toLowerCase();
  return gprByToken.get(token);
}

const cp0Names = new Map<string, number>([
  ['$12', 12], ['12', 12], ['$sr', 12], ['sr', 12], ['$status', 12], ['status', 12],
  ['$13', 13], ['13', 13], ['$cause', 13], ['cause', 13],
  ['$14', 14], ['14', 14], ['$epc', 14], ['epc', 14]
]);

/** CP0 operand surface: only the course-required SR/Cause/EPC registers. */
export function parseCp0Register(text: string): number | undefined {
  const token = text.trim().toLowerCase();
  if (/^\$\d{1,2}$/.test(token)) {
    const number = Number(token.slice(1));
    return number >= 0 && number <= 31 ? number : undefined;
  }
  return cp0Names.get(token);
}
