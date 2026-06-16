export function isClockOrResetSignal(name: string): boolean {
  return /(?:^|_)(?:clk|clock|rst|reset|clr|clear)(?:_n)?(?:_|$)/i.test(name);
}

export function isClockSignalName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('clk') || lower.includes('clock');
}
