import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLanes,
  expectedProfiles,
  expectedScenarios
} from '../scripts/legacy-equivalence-evidence.mjs';

const reference = {
  role: 'fixture-reference',
  verifiedSha256: 'a'.repeat(64)
};

test('equivalence comparator accepts the complete exact fixture matrix', (context) => {
  const fixture = createFixture(context);
  const result = compareLanes(fixture);
  assert.equal(result.length, expectedProfiles.length * expectedScenarios.length);
  assert.ok(result.every((item) => Object.values(item.equality).every(Boolean)));
});

test('equivalence comparator rejects byte drift even when the lane updates its own digest', (context) => {
  const fixture = createFixture(context);
  const item = fixture.currentManifest.cases.find((candidate) => candidate.scenario === 'success');
  assert.ok(item);
  const file = path.join(fixture.currentArtifacts, item.trace.relativePath);
  const drifted = Buffer.from('provider trace drift\n');
  fs.writeFileSync(file, drifted);
  item.trace.bytes = drifted.byteLength;
  item.trace.sha256 = sha256(drifted);
  assert.throws(() => compareLanes(fixture), /trace bytes differ/);
});

test('equivalence comparator rejects a matching but unexpected verdict', (context) => {
  const fixture = createFixture(context);
  const baseline = fixture.baselineManifest.cases.find((candidate) => candidate.scenario === 'assembly-failure');
  const current = fixture.currentManifest.cases.find((candidate) => candidate.scenario === 'assembly-failure');
  assert.ok(baseline && current);
  baseline.verdict = 'passed';
  current.verdict = 'passed';
  assert.throws(() => compareLanes(fixture), /baseline verdict passed did not meet failed/);
});

function createFixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-legacy-evidence-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineArtifacts = path.join(root, 'baseline');
  const currentArtifacts = path.join(root, 'current');
  fs.mkdirSync(baselineArtifacts);
  fs.mkdirSync(currentArtifacts);
  const baselineCases = [];
  const currentCases = [];
  for (const profile of expectedProfiles) {
    for (const scenario of expectedScenarios) {
      const id = `${reference.role}--${profile.toLowerCase()}--${scenario}`;
      const expectedVerdict = scenario === 'success' ? 'passed' : 'failed';
      const relativeMachine = `cases/${id}/machine.txt`;
      const relativeTrace = `cases/${id}/trace.txt`;
      let machine = absentArtifact(relativeMachine);
      let trace = absentArtifact(relativeTrace);
      if (scenario === 'success') {
        const machineBytes = Buffer.from(`${profile} machine\n`);
        const traceBytes = Buffer.from(`${profile} trace\n`);
        writeArtifact(baselineArtifacts, relativeMachine, machineBytes);
        writeArtifact(currentArtifacts, relativeMachine, machineBytes);
        writeArtifact(baselineArtifacts, relativeTrace, traceBytes);
        writeArtifact(currentArtifacts, relativeTrace, traceBytes);
        machine = presentArtifact(relativeMachine, machineBytes);
        trace = presentArtifact(relativeTrace, traceBytes);
      }
      const common = {
        caseId: id,
        role: reference.role,
        referenceSha256: reference.verifiedSha256,
        profile,
        scenario,
        expectedVerdict,
        verdict: expectedVerdict,
        haltPc: scenario === 'success' ? '0x00003000' : null,
        machineCode: machine,
        trace,
        assembleExitCode: scenario === 'success' ? 0 : 1,
        executeExitCode: scenario === 'success' ? 0 : null,
        engineSha256: reference.verifiedSha256
      };
      baselineCases.push(structuredClone(common));
      currentCases.push(structuredClone(common));
    }
  }
  return {
    baselineManifest: { cases: baselineCases },
    currentManifest: { cases: currentCases },
    baselineArtifacts,
    currentArtifacts,
    references: [reference]
  };
}

function writeArtifact(root, relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function presentArtifact(relativePath, bytes) {
  return { relativePath, present: true, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function absentArtifact(relativePath) {
  return { relativePath, present: false, bytes: 0, sha256: null };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
