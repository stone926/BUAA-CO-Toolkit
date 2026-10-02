// @index mips-debug — Validate untrusted workbench messages before host actions
import type { WorkbenchRequest } from './protocol';

export function parseWorkbenchRequest(value: unknown): WorkbenchRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const only = (...keys: string[]) => Object.keys(item).every(key => key === 'type' || keys.includes(key));
  const address = (raw: unknown) => Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= 0xfffffffc && (raw as number) % 4 === 0;
  switch (item.type) {
    case 'ready': case 'assemble': case 'run': case 'pause': case 'step': case 'reset':
    case 'stop': case 'clearConsole': case 'eof': case 'export':
      return only() ? item as WorkbenchRequest : undefined;
    case 'mode': return only('mode') && typeof item.mode === 'string' && /^(mars|P[3-7])$/.test(item.mode) ? item as WorkbenchRequest : undefined;
    case 'memory': return only('address') && address(item.address) && (item.address as number) <= 0xffffff00 ? item as WorkbenchRequest : undefined;
    case 'breakpoint': case 'source': return only('address') && address(item.address) ? item as WorkbenchRequest : undefined;
    case 'listing': return only('offset', 'address') && Number.isInteger(item.offset) && (item.offset as number) >= 0
      && (item.offset as number) <= 2_097_152 && (item.address === undefined || address(item.address)) ? item as WorkbenchRequest : undefined;
    case 'input': return only('text') && typeof item.text === 'string' && item.text.length <= 16_384 ? item as WorkbenchRequest : undefined;
    default: return undefined;
  }
}
