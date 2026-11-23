// @index course-testing — Strict 32-bit words from public four-state trace tokens
export function parseProbeHexWord(value: string): number {
  return /^(?:0x)?[0-9a-f]{1,8}$/i.test(value) ? Number.parseInt(value, 16) : Number.NaN;
}

export function parseProbeRegister(value: string): number {
  return /^\d{1,2}$/.test(value) && Number(value) < 32 ? Number(value) : Number.NaN;
}
