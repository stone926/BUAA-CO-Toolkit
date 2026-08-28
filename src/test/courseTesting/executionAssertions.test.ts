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

  it('matches trap PCs against the victim and excludes non-instruction events', () => {
    const trap = event({
      kind: 'exception',
      pcBefore: 0x3010,
      pcAfter: 0x4180,
      gprWrites: [],
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
    });
    const halt = event({
      sequence: 1,
      kind: 'halt',
      pcBefore: 0x3000,
      pcAfter: 0x3000,
      gprWrites: [],
      haltReason: 'course-halt-loop'
    });
    const observer = new ExecutionAssertionObserver([
      { id: 'instruction', kind: 'instruction', pc: 0x3000 },
      { id: 'trap-victim', kind: 'trap', pc: 0x3000 },
      { id: 'trap-event-pc', kind: 'trap', pc: 0x3010 }
    ], []);

    const result = observer.observeAll([trap, halt]);
    expect(result.watchpointHits.map((hit) => hit.watchpointId)).toEqual(['trap-victim']);
  });

  it('treats omitted write discriminators as watchpoint wildcards', () => {
    const observer = new ExecutionAssertionObserver([
      { id: 'any-gpr', kind: 'gpr-write' },
      { id: 'any-memory', kind: 'memory-write' },
      { id: 'any-cp0', kind: 'cp0-write' }
    ], []);
    const result = observer.observeAll([event({
      gprWrites: [{ register: 8, value: 1 }],
      memoryWrites: [{
        address: 0x1000,
        rawValue: 2,
        wordAddress: 0x1000,
        byteMask: 0b1111,
        valueBefore: 0,
        valueAfter: 2,
        region: 'data'
      }],
      cp0Writes: [{ register: 12, value: 3, valueBefore: 0 }]
    })]);

    expect(result.watchpointHits).toEqual([
      expect.objectContaining({ watchpointId: 'any-gpr', detail: 'gpr $8' }),
      expect.objectContaining({ watchpointId: 'any-memory', detail: 'memory 0x00001000' }),
      expect.objectContaining({ watchpointId: 'any-cp0', detail: 'cp0[12]' })
    ]);
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

  it('evaluates trap/no-trap and delay-slot halt assertions from streamed events', () => {
    const observer = new ExecutionAssertionObserver([], [
      { id: 'trap-syscall', kind: 'trap', trapName: 'syscall' },
      { id: 'no-trap', kind: 'no-trap' },
      { id: 'halt', kind: 'halt-pc', haltPc: 0x3004 },
      { id: 'wrong-halt', kind: 'halt-pc', haltPc: 0x3008 }
    ]);
    observer.observe(event({
      kind: 'exception',
      mnemonic: 'syscall',
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
    }));
    observer.observe(event({
      sequence: 1,
      pcBefore: 0x3008,
      pcAfter: 0x3004,
      delaySlot: true,
      branchOriginPc: 0x3004,
      gprWrites: [],
      mnemonic: 'nop',
      haltReason: 'course-halt-loop'
    }));

    expect(observer.finish().assertionFailures.map((failure) => failure.assertionId))
      .toEqual(['no-trap', 'wrong-halt']);
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
