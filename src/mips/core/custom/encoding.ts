// @index mips-core — Parses custom instruction bits and named fields for encoding and display

export interface CustomEncodingField {
  readonly name: string;
  readonly width: number;
  readonly shift: number;
}

export interface CustomEncodingPart {
  readonly text: string;
  readonly width: number;
  readonly shift: number;
}

export function customEncodingFieldMask(width: number): number {
  return width === 32 ? 0xffff_ffff : 2 ** width - 1;
}

/** Keep the source's fixed-bit groups separate, even when they are adjacent. */
export function parseCustomInstructionEncoding(encoding: string, mnemonic: string): {
  fields: CustomEncodingField[];
  parts: CustomEncodingPart[];
  mask: number;
  value: number;
} {
  if (typeof encoding !== 'string') throw new Error(`${mnemonic}: encoding must be a bit pattern`);
  let remaining = 32;
  let mask = 0;
  let value = 0;
  const fields: CustomEncodingField[] = [];
  const parts: CustomEncodingPart[] = [];
  for (const token of encoding.trim().split(/\s+/)) {
    if (/^[01]+$/.test(token)) {
      const width = token.length;
      remaining -= width;
      if (remaining < 0) throw new Error(`${mnemonic}: encoding exceeds 32 bits`);
      mask = (mask | (customEncodingFieldMask(width) << remaining)) >>> 0;
      value = (value | (parseInt(token, 2) << remaining)) >>> 0;
      parts.push({ text: token, width, shift: remaining });
    } else {
      const match = /^([A-Za-z][A-Za-z0-9_]*):([1-9][0-9]?)$/.exec(token);
      if (!match || Number(match[2]) > 31) throw new Error(`${mnemonic}: invalid encoding token ${token}`);
      const name = match[1];
      const width = Number(match[2]);
      remaining -= width;
      if (remaining < 0 || fields.some(field => field.name === name)) throw new Error(`${mnemonic}: duplicate field or encoding exceeds 32 bits`);
      fields.push({ name, width, shift: remaining });
      parts.push({ text: name, width, shift: remaining });
    }
  }
  if (remaining !== 0 || mask === 0) throw new Error(`${mnemonic}: encoding must total 32 bits with fixed selector bits`);
  return { fields, parts, mask, value };
}
