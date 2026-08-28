import { describe, expect, it } from 'vitest';
import {
  evaluateCourseAssertions,
  ExecutionAssertionObserver
} from '../../courseTesting/oracle/executionAssertions';
import type { CommitEvent } from '../../mips/core/events/commitEvent';

function event(overrides: Partial<CommitEvent> = {}): CommitEvent {
  return {
    sequence: 0,
    kind: 'instruction',
    pcBefore: 0x3000,
    pcAfter: 0x3004,
    gprWrites: [{ register: 8, value: 1 }],
    hiLoWrites: [],
    cp0Writes: [],
    memoryWrites: [],
    deviceEvents: [],
    mnemonic: 'ori',
    ...overrides
  };
}

describe('execution assertion/watchpoint observers', () => {
  it('observes gpr and instruction watchpoints with stable details', () => {
    const observer = new ExecutionAssertionObserver([
      { id: 'gpr8', kind: 'gpr-write', register: 8 },
      { id: 'pc3000', kind: 'instruction', pc: 0x3000 }
    ], []);
    const result = observer.observeAll([event(), event({ sequence: 1, pcBefore: 0x3004 })]);
    expect(result.watchpointHits).toHaveLength(3);
    expect(result.watchpointHits[0]).toMatchObject({ watchpointId: 'gpr8', pc: '0x00003000' });
    expect(result.watchpointHits[1]).toMatchObject({ watchpointId: 'pc3000', pc: '0x00003000' });
  });

  it('evaluates trap assertions against the full commit stream', () => {
    const syscall = event({
      kind: 'exception',
      mnemonic: 'syscall',
      pcAfter: 0x4180,
      gprWrites: [],
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
    });
    expect(evaluateCourseAssertions([syscall], [
      { id: 'trap-syscall', kind: 'trap', trapName: 'syscall' }
    ])).toEqual([]);
    expect(evaluateCourseAssertions([event()], [
      { id: 'no-trap', kind: 'no-trap' }
    ])).toEqual([]);
    expect(evaluateCourseAssertions([event()], [
      { id: 'trap-adel', kind: 'trap', trapName: 'adel' }
    ]).map((item) => item.assertionId)).toEqual(['trap-adel']);
  });

  it('stops recording a limited watchpoint after its limit', () => {
    const observer = new ExecutionAssertionObserver([
      { id: 'gpr8', kind: 'gpr-write', register: 8, limit: 1 }
    ], []);
    const result = observer.observeAll([
      event(),
      event({ sequence: 1, pcBefore: 0x3004 }),
      event({ sequence: 2, pcBefore: 0x3008 })
    ]);
    expect(result.watchpointHits).toHaveLength(1);
    expect(result.watchpointHits[0]).toMatchObject({ watchpointId: 'gpr8', sequence: 0 });
  });

  it('enforces hit count bounds on a watchpoint', () => {
    const observer = new ExecutionAssertionObserver([
      { id: 'gpr8', kind: 'gpr-write', register: 8 }
    ], [{ id: 'once', kind: 'max-hits', watchpointId: 'gpr8', minHits: 2, maxHits: 2 }]);
    const result = observer.observeAll([event()]);
    expect(result.assertionFailures[0]).toMatchObject({ assertionId: 'once' });
  });
});
