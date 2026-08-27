import { describe, expect, it } from 'vitest';

import { compareExecutorShadow, traceFinalStateDigest } from '../../courseTesting/oracle/differentialRunner';
import { firstCommitEventDiff, projectCommitEvent } from '../../courseTesting/oracle/commitProjection';
import type { ShadowExecutionEvidence } from '../../courseTesting/oracle/differentialRunner';
import type { CpuTraceEvent } from '../../language/mips/traceParser';
import type { CommitEvent } from '../../mips/core/events/commitEvent';

function trace(pc = '00003000', target = '8', value = '0000002A'): CpuTraceEvent {
  return {
    pc,
    kind: 'grf',
    target,
    value,
    raw: `@${pc}: $${target} <= ${value}`,
    lineNumber: 1
  };
}

function evidence(
  overrides: Partial<ShadowExecutionEvidence> = {}
): ShadowExecutionEvidence {
  return {
    engineId: 'legacy-mars-configured',
    ok: true,
    rawText: '',
    traceEvents: [trace()],
    stopKind: 'halt-loop',
    ...overrides
  };
}

function syscallEvent(): CommitEvent {
  return {
    sequence: 0,
    kind: 'exception',
    pcBefore: 0x3000,
    instructionWord: 0x0000000c,
    pcAfter: 0x4180,
    gprWrites: [],
    hiLoWrites: [],
    cp0Writes: [],
    memoryWrites: [],
    deviceEvents: [],
    mnemonic: 'syscall',
    trap: {
      kind: 'exception',
      name: 'syscall',
      code: 8,
      victimPc: 0x3000,
      branchDelay: false,
      epc: 0x3000,
      stage: 'decode',
      handlerPc: 0x4180
    }
  };
}

describe('executor shadow differential', () => {
  it('matches identical ordered architectural traces', () => {
    const diff = compareExecutorShadow(evidence(), evidence({ engineId: 'builtin-ts' }), { profile: 'P5' });
    expect(diff.matched).toBe(true);
    expect(diff.disposition).toBe('matched');
    expect(diff.legacyTraceDigest).toBe(diff.builtinTraceDigest);
  });

  it('classifies an unregistered trace difference as inconclusive', () => {
    const diff = compareExecutorShadow(
      evidence(),
      evidence({
        engineId: 'builtin-ts',
        traceEvents: [trace('00003000', '8', '0000002B')]
      }),
      { profile: 'P5' }
    );
    expect(diff.matched).toBe(false);
    expect(diff.disposition).toBe('inconclusive');
    expect(diff.firstDiff?.index).toBe(0);
    expect(diff.firstDiff?.oracle?.value).toBe('0000002A');
    expect(diff.firstDiff?.dut?.value).toBe('0000002B');
  });

  it('classifies the registered P7 syscall divergence as course-correct', () => {
    const diff = compareExecutorShadow(
      evidence(),
      evidence({
        engineId: 'builtin-ts',
        traceEvents: [],
        events: [syscallEvent()]
      }),
      { profile: 'P7' }
    );
    expect(diff.disposition).toBe('course-correct');
    expect(diff.classification?.contractId).toBe('MARS-DIV-P7SYSCALL-001');
    expect(diff.firstDiffCommitEvent?.mnemonic).toBe('syscall');
  });

  it('is not comparable when the builtin oracle did not complete', () => {
    const diff = compareExecutorShadow(
      evidence(),
      evidence({ engineId: 'builtin-ts', ok: false, stopKind: 'out-of-domain', diagnosticCode: 'mips-core.exec.unloaded-instruction' }),
      { profile: 'P5' }
    );
    expect(diff.disposition).toBe('not-comparable');
    expect(diff.notComparableReason).toContain('unloaded-instruction');
  });

  it('produces a deterministic last-write-wins final trace digest', () => {
    const a = [trace('00003000', '8', '00000001'), trace('00003004', '9', '00000002')];
    const b = [trace('00003000', '8', '00000001'), trace('00003004', '9', '00000002')];
    expect(traceFinalStateDigest(a)).toBe(traceFinalStateDigest(b));
  });
});

describe('structured commit projection', () => {
  it('renders PC, word, CP0, memory and device writes in one diagnostic view', () => {
    const view = projectCommitEvent({
      ...syscallEvent(),
      kind: 'instruction',
      mnemonic: 'sw',
      pcBefore: 0x3000,
      pcAfter: 0x3004,
      cp0Writes: [{ register: 12, valueBefore: 0, value: 1 }],
      memoryWrites: [{
        address: 0,
        rawValue: 0x2a,
        wordAddress: 0,
        byteMask: 0xf,
        valueBefore: 0,
        valueAfter: 0x2a,
        region: 'data'
      }],
      deviceEvents: [{ kind: 'timer-register-write', device: 'timer0', address: 0x7f00, value: 1 }],
      trap: undefined
    });
    expect(view.pcBefore).toBe('0x00003000');
    expect(view.instructionWord).toBeDefined();
    expect(view.cp0Writes.join(' ')).toContain('cp0[12]');
    expect(view.memoryWrites.join(' ')).toContain('data[0x00000000]');
    expect(view.deviceEvents.join(' ')).toContain('timer0:timer-register-write');
  });
});

describe('structured commit first diff', () => {
  it('locates the first canonical event difference', () => {
    const left = [syscallEvent()];
    const right = [{ ...syscallEvent(), pcAfter: 0x4184 }];
    const diff = firstCommitEventDiff(left, right);
    expect(diff?.index).toBe(0);
    expect(diff?.reason).toBe('canonical commit event differs');
  });

  it('returns undefined for identical streams', () => {
    expect(firstCommitEventDiff([syscallEvent()], [syscallEvent()])).toBeUndefined();
  });
});
