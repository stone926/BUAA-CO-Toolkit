// @index mips-core — MARS floating-point input and Java-style console number formatting
export function parseFloatingPoint(text: string): number {
  const clean = text.trim();
  if (/^[+-]?NaN$/.test(clean)) { return Number.NaN; }
  if (/^[+-]?Infinity$/.test(clean)) { return clean.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY; }
  const decimal = clean.replace(/[fFdD]$/, '');
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(decimal)) { return Number(decimal); }
  const hex = /^([+-]?)0[xX]([\da-fA-F]+(?:\.[\da-fA-F]*)?|\.[\da-fA-F]+)[pP]([+-]?\d+)$/.exec(decimal);
  if (hex) {
    const [integer, fraction = ''] = hex[2].split('.');
    const mantissa = parseInt(integer || '0', 16) + (fraction ? parseInt(fraction, 16) / 16 ** fraction.length : 0);
    return (hex[1] === '-' ? -1 : 1) * mantissa * 2 ** Number(hex[3]);
  }
  throw new Error('Invalid floating-point input');
}

/** Round single values to a short decimal that maps back to the same float bits. */
export function formatFloatingPoint(value: number, single: boolean): string {
  if (Number.isNaN(value)) { return 'NaN'; }
  if (!Number.isFinite(value)) { return value < 0 ? '-Infinity' : 'Infinity'; }
  if (Object.is(value, -0)) { return '-0.0'; }
  if (value === 0) { return '0.0'; }
  // Java chooses the nearest two-significant-digit decimal for the smallest
  // double. ECMAScript's shortest spelling is 5e-324, which MARS never prints.
  if (!single && Math.abs(value) === Number.MIN_VALUE) {
    return value < 0 ? '-4.9E-324' : '4.9E-324';
  }
  let rounded = value;
  if (single) {
    for (let digits = 2; digits <= 9; digits++) {
      const candidate = Number(value.toPrecision(digits));
      if (Math.fround(candidate) === value) { rounded = candidate; break; }
    }
  }
  const magnitude = Math.abs(value);
  if (magnitude >= 0.001 && magnitude < 10_000_000) {
    const text = String(rounded);
    return text.includes('.') ? text : `${text}.0`;
  }
  const [mantissa, exponent] = rounded.toExponential().split('e');
  return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}E${Number(exponent)}`;
}
