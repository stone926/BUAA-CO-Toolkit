// @index course-testing — Verify public scratch stores capturing the first CP0 state in a packed record
import type { CpuTraceEvent } from '../language/mips/traceParser';
import { p7ProbeStateFirstCause, p7ProbeStateFirstEpc, p7ProbeStateFirstStatus } from './p7Hardware';
import { parseProbeHexWord } from './p7ProbeTraceWord';

export interface P7ProbeCapturePcs {
  statusPc: number;
  causePc: number;
  epcPc: number;
}

export function readP7ProbeCapture(
  atPc: (pc: number) => readonly CpuTraceEvent[],
  pcs: P7ProbeCapturePcs,
  afterLine: number,
  beforeLine: number
): { capture?: { status: number; cause: number; epc: number }; invalid: boolean } {
  let invalid = false;
  const status = readCapture(pcs.statusPc, p7ProbeStateFirstStatus);
  const cause = readCapture(pcs.causePc, p7ProbeStateFirstCause);
  const epc = readCapture(pcs.epcPc, p7ProbeStateFirstEpc);
  if (!status || !cause || !epc) return { invalid };
  if (status.line >= cause.line || cause.line >= epc.line) return { invalid: true };
  return { capture: { status: status.value, cause: cause.value, epc: epc.value }, invalid: false };

  function readCapture(pc: number, address: number): { value: number; line: number } | undefined {
    const events = atPc(pc).filter(event => event.lineNumber > afterLine && event.lineNumber < beforeLine);
    if (!events.length) return undefined;
    const [event] = events;
    const value = parseProbeHexWord(event.value);
    if (events.length !== 1 || event.kind !== 'dm' || parseProbeHexWord(event.target) !== address || !Number.isFinite(value)) {
      invalid = true;
      return undefined;
    }
    return { value, line: event.lineNumber };
  }
}
