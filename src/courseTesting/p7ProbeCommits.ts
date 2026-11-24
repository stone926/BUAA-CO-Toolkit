// @index course-testing — Required architectural writes before and after a P7 handler record
import type { CpuTraceEvent } from '../language/mips/traceParser';
import type { P7ProbeCommitExpectation, P7ProbeScenario } from './builtinAsm/types';
import type { P7ProbeRecord } from './p7ProbeCheck';
import { parseProbeHexWord, parseProbeRegister } from './p7ProbeTraceWord';
import { matchesP7ObservedWord, p7CommitObservationMask } from './p7Cp0Observation';
import type { ProgramImage } from '../mips/core/api';

export function matchingCommits(events: readonly CpuTraceEvent[], expected: P7ProbeCommitExpectation, image?: ProgramImage): CpuTraceEvent[] {
  const mask = p7CommitObservationMask(expected, image);
  return events.filter(event => event.kind === expected.kind && parseProbeHexWord(event.pc) === expected.pc
    && (event.kind === 'grf' ? parseProbeRegister(event.target) : parseProbeHexWord(event.target)) === expected.target
    && matchesP7ObservedWord(parseProbeHexWord(event.value), expected.value, mask));
}

export function checkRequiredProbeCommits(
  scenario: P7ProbeScenario, atPc: (pc: number) => readonly CpuTraceEvent[], record: P7ProbeRecord | undefined,
  report: (message: string, observed?: true) => void, image?: ProgramImage
): void {
  const before = scenario.requiredPreHandlerCommits ?? [];
  const after = scenario.requiredCommits ?? [];
  const expected = [...before, ...after];
  for (const pc of new Set(expected.map(commit => commit.pc))) {
    const allowed = expected.filter(commit => commit.pc === pc);
    const actual = atPc(pc);
    if (actual.length !== allowed.length) {
      report(`必要提交 PC 0x${pc.toString(16)}：应有 ${allowed.length} 次写入，实际 ${actual.length} 次`,
        actual.length > allowed.length ? true : undefined);
    }
    for (const commit of allowed) {
      const preHandler = before.includes(commit);
      const label = `必要的${preHandler ? '异常前 ' : ' '}${commit.kind.toUpperCase()} 提交（PC 0x${pc.toString(16)}）`;
      const matches = matchingCommits(actual, commit, image);
      if (matches.length !== 1) {
        if (allowed.length === 1 && actual.length === 1) {
          const event = actual[0];
          const target = commit.kind === 'grf' ? `$${commit.target}` : `*0x${commit.target.toString(16)}`;
          const actualTarget = event.kind === 'grf' ? `$${event.target}` : `*0x${event.target}`;
          const mask = p7CommitObservationMask(commit, image);
          const comparison = mask === undefined ? '' : `（仅比较掩码 0x${mask.toString(16).padStart(8, '0')} 的位）`;
          report(`${label}读回值不符：应为 ${target}=0x${commit.value.toString(16)}，实际为 ${actualTarget}=0x${event.value}${comparison}`, true);
        } else {
          report(`${label}应恰好匹配一次，实际匹配 ${matches.length} 次`,
            matches.length > 1 || (preHandler && record) ? true : undefined);
        }
      } else if (record && preHandler && matches[0].lineNumber >= record.firstLineNumber) {
        report('必要的异常前提交出现在异常处理程序记录开始之后', true);
      } else if (record && !preHandler && matches[0].lineNumber <= record.lastLineNumber) {
        report('必要的重试提交出现在异常处理程序记录之前', true);
      }
    }
  }
}
