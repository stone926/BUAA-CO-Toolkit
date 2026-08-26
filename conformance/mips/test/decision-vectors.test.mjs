import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateCp0Case,
  evaluateExceptionCase,
  evaluateUnloadedCase,
  loadDecisionArtifacts,
  runDecisionVectors
} from '../decision-vectors/runner.mjs';

test('all frozen decisions have independent vector artifacts', () => {
  const { entries } = loadDecisionArtifacts();
  assert.deepEqual(entries.map(({ entry }) => entry.id).sort(), [
    'COURSE-P7-CP0-SAME-CYCLE-001',
    'COURSE-P7-EXC-PRIORITY-001',
    'COURSE-P7-TIMER-RESTART-001',
    'COURSE-P7-UNLOADED-IM-001'
  ]);
});

test('decision vectors pass locally or explicitly report missing RTL tools', () => {
  const report = runDecisionVectors();
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.results.length, 4);
  for (const result of report.results) {
    if (result.id === 'COURSE-P7-TIMER-RESTART-001') assert.match(result.status, /^(passed|unavailable)$/u);
    else assert.equal(result.status, 'passed', JSON.stringify(result));
  }
});

test('priority oracle detects a reversed same-victim stage order', () => {
  const input = { enabledInterrupt: false, victims: [{ age: 0, exceptions: [{ stage: 'F', code: 4 }, { stage: 'D', code: 10 }] }] };
  assert.deepEqual(evaluateExceptionCase({ sameVictimStageOrder: ['F', 'D', 'E', 'M'] }, input), {
    winner: 'exception', code: 4, victimAge: 0, stage: 'F', retryCode: null
  });
  assert.notDeepEqual(evaluateExceptionCase({ sameVictimStageOrder: ['D', 'F', 'E', 'M'] }, input), {
    winner: 'exception', code: 4, victimAge: 0, stage: 'F', retryCode: null
  });
});

test('CP0 interrupt qualification uses pre-instruction SR', () => {
  const first = evaluateCp0Case({
    state: { sr: '0x00000000', cause: '0x00000000', epc: '0x00000000' },
    hwInt: '0x01', exceptionCode: 0, victimPc: '0x00003000', inDelaySlot: false,
    action: { kind: 'mtc0-sr', value: '0x00000401' }
  });
  assert.equal(first.accepted, 'none');
  assert.equal(first.state.sr, '0x00000401');
  assert.equal(first.state.cause, '0x00000400', 'Cause.IP must mirror HWInt even without accepted Req');
  const next = evaluateCp0Case({
    state: first.state, hwInt: '0x01', exceptionCode: 0, victimPc: '0x00003004', inDelaySlot: false,
    action: { kind: 'none' }
  });
  assert.equal(next.accepted, 'interrupt');
  assert.equal(next.state.cause, '0x00000400', 'accepted interrupt keeps Cause.IP and writes ExcCode=0');
});

test('unloaded legal word is not AdEL and zero-fill is opt-in synthetic only', () => {
  const base = { pc: '0x00003100', image: {}, mode: 'strict' };
  assert.deepEqual(evaluateUnloadedCase(base), {
    status: 'out-of-domain', reason: 'unloaded-instruction', instruction: null, synthetic: false, exception: null
  });
  assert.equal(evaluateUnloadedCase({ ...base, mode: 'exploratory-zero-fill' }).synthetic, true);
  assert.equal(evaluateUnloadedCase({ ...base, pc: '0x00007000' }).exception, 'AdEL');
});
