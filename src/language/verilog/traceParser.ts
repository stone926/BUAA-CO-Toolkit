import { CpuTraceEvent, parseCpuTraceOutput } from '../mips/traceParser';

export type DisplayTraceProfile = 'P4' | 'P5+';
export type DisplayTraceKind = 'grf' | 'dm';

export interface DisplayTraceFormat {
  profile: DisplayTraceProfile;
  kind: DisplayTraceKind;
  rawFormat: string;
}

const displayPattern = /\$display\s*\(\s*"([^"]*)"/g;

export function parseSimOutput(text: string): CpuTraceEvent[] {
  return parseCpuTraceOutput(text);
}

export function detectDisplayTraceFormats(verilogText: string): DisplayTraceFormat[] {
  const formats: DisplayTraceFormat[] = [];
  for (const match of verilogText.matchAll(displayPattern)) {
    const rawFormat = normalizeDisplayFormat(match[1]);
    const kind = displayTraceKind(rawFormat);
    const profile = displayTraceProfile(rawFormat);
    if (kind && profile) {
      formats.push({ profile, kind, rawFormat });
    }
  }
  return formats;
}

function normalizeDisplayFormat(format: string): string {
  return format.replace(/\\n/g, '').replace(/\s+/g, ' ').trim();
}

function displayTraceKind(format: string): DisplayTraceKind | undefined {
  if (/\$%0?\d*d|\$%d/i.test(format)) {
    return 'grf';
  }
  if (/\*%0?\d*h|\*%h/i.test(format)) {
    return 'dm';
  }
  return undefined;
}

function displayTraceProfile(format: string): DisplayTraceProfile | undefined {
  if (/^%0?\d*d@%0?\d*h:/i.test(format)) {
    return 'P5+';
  }
  if (/^@%0?\d*h:/i.test(format)) {
    return 'P4';
  }
  return undefined;
}
