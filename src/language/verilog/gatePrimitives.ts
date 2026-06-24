const verilogGatePrimitiveNames = [
  'and',
  'nand',
  'or',
  'nor',
  'xor',
  'xnor',
  'buf',
  'not',
  'bufif0',
  'bufif1',
  'notif0',
  'notif1',
  'pulldown',
  'pullup',
  'nmos',
  'pmos',
  'rnmos',
  'rpmos',
  'cmos',
  'rcmos',
  'tran',
  'rtran',
  'tranif0',
  'tranif1',
  'rtranif0',
  'rtranif1'
];

export const verilogGatePrimitives = new Set(verilogGatePrimitiveNames);

export function isVerilogGatePrimitive(value: string): boolean {
  return verilogGatePrimitives.has(value);
}
