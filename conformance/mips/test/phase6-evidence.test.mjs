import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionCorpusManifest } from '../corpus/generate-execution-corpus.mjs';
import { renderExecutionProgram } from '../corpus/execution-program-renderer.mjs';
import { loadReferenceManifest, referenceRoles } from '../reference/referenceAssets.mjs';
import { sha256CanonicalJson } from '../runner/canonicalJson.mjs';
import { executableImageFingerprint } from '../runner/executionDifferential.mjs';
import { phase6EvidenceIssues } from '../runner/validatePhase6Evidence.mjs';

const profiles = ['P3', 'P4', 'P5', 'P6', 'P7'];
const digest = '1'.repeat(64);
const manifest = buildExecutionCorpusManifest();
const reference = loadReferenceManifest().assets.find(
  (entry) => entry.role === referenceRoles.legacyCourseExecutor
);
const emptyWrites = [];
const emptyFinalSummary = { gpr: {}, dm: {}, writes: { gpr: [], dm: [] } };

function assemblyCli(profile) {
  return [
    'a', 'nc', 'mc', profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText', 'ae1',
    ...(['P5', 'P6', 'P7'].includes(profile) ? ['db'] : []),
    ...(profile === 'P7' ? ['efc'] : []),
    'dump', '.text', 'HexText', '<TEXT-IMAGE>', '<SOURCE>'
  ];
}

function executionCli(profile, haltPc, maxSteps) {
  return [
    'nc', 'mc', profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText', 'ae1', 'se1',
    ...(['P5', 'P6', 'P7'].includes(profile) ? ['db'] : []),
    ...(profile === 'P7' ? ['efc'] : []),
    'coZeroGpr', 'coStrictData', `coHalt=${haltPc}`, 'coL2', String(maxSteps), '<SOURCE>'
  ];
}

function passingCase(entry, kind) {
  const generatedProgram = kind === 'generated' ? renderExecutionProgram(entry) : undefined;
  const haltPc = generatedProgram?.haltPc ?? '0x00003018';
  const imageFingerprint = generatedProgram
    ? executableImageFingerprint(generatedProgram.words)
    : digest;
  const stop = {
    kind: 'course-halt-loop',
    haltPc,
    haltWord: '0x1000ffff',
    instructions: 7
  };
  const evidence = {
    instructions: 7,
    stop,
    writes: emptyWrites,
    eventDigest: sha256CanonicalJson(emptyWrites),
    finalSummary: emptyFinalSummary,
    finalSummaryDigest: sha256CanonicalJson(emptyFinalSummary)
  };
  return {
    id: entry.id,
    profile: entry.profile,
    kind,
    status: 'passed',
    image: {
      fingerprintRevision: 1,
      tsFingerprint: imageFingerprint,
      marsFingerprint: imageFingerprint,
      tsAssemblerProgramImageFingerprint: digest,
      words: generatedProgram?.words.length ?? 8,
      matched: true,
      verifiedBeforeExecution: true,
      referenceRole: 'legacy-course-executor',
      referenceSha256: reference.sha256
    },
    legacy: structuredClone(evidence),
    builtin: {
      ...structuredClone(evidence),
      nativeFinalState: {
        pc: haltPc,
        gpr: Array(32).fill('0x00000000'),
        hi: '0x00000000',
        lo: '0x00000000',
        hiDefined: false,
        loDefined: false,
        dataWords: []
      },
      nativeFinalStateDigest: digest,
      executionImageFingerprint: digest
    },
    comparison: {
      status: 'passed',
      classification: 'matched',
      mismatches: []
    },
    assemblyRun: {
      role: 'legacy-course-executor',
      referenceSha256: reference.sha256,
      cliOptions: assemblyCli(entry.profile)
    },
    referenceRun: {
      role: 'legacy-course-executor',
      referenceSha256: reference.sha256,
      effectiveMaxSteps: entry.maxSteps,
      cliOptions: executionCli(entry.profile, haltPc, entry.maxSteps)
    }
  };
}

function passingFixture() {
  const documents = new Map();
  const pointers = {};
  for (const profile of profiles) {
    const cases = [
      ...manifest.generated.filter((entry) => entry.profile === profile)
        .map((entry) => passingCase(entry, 'generated')),
      ...manifest.handwritten.filter((entry) => entry.profile === profile)
        .map((entry) => passingCase(entry, 'handwritten'))
    ];
    const document = {
      schemaRevision: 1,
      evidenceKind: 'real-execution-differential',
      profile,
      runnerRevision: 1,
      selected: 51,
      generated: 50,
      handwritten: 1,
      passed: 51,
      explainedDifferences: 0,
      unexplained: 0,
      failed: 0,
      inconclusive: 0,
      outOfDomain: 0,
      error: 0,
      reference: {
        role: reference.role,
        fileName: reference.fileName,
        sha256: reference.sha256,
        sourceTag: reference.sourceTag,
        sourceCommit: reference.sourceCommit
      },
      ts: {
        protocolVersion: 1,
        executor: { id: 'builtin-ts-executor' },
        assembler: { id: 'builtin-ts-assembler' }
      },
      cases
    };
    documents.set(profile, document);
    pointers[profile] = {
      file: `${profile}.json`,
      selected: 51,
      generated: 50,
      handwritten: 1,
      passed: 51,
      explainedDifferences: 0,
      unexplained: 0,
      failed: 0,
      inconclusive: 0,
      outOfDomain: 0,
      error: 0,
      payloadSha256: sha256CanonicalJson(document)
    };
  }
  return {
    summary: {
      schemaRevision: 1,
      evidenceKind: 'real-execution-differential-summary',
      batchId: manifest.batch.id,
      corpusPayloadSha256: manifest.integrity.payloadSha256,
      runnerRevision: 1,
      generatedRequired: 250,
      profilesRequired: profiles,
      selected: 255,
      generated: 250,
      handwritten: 5,
      passed: 255,
      explainedDifferences: 0,
      unexplained: 0,
      failed: 0,
      inconclusive: 0,
      outOfDomain: 0,
      error: 0,
      profiles: pointers
    },
    documents
  };
}

test('phase-6 aggregate accepts complete real execution evidence', () => {
  const fixture = passingFixture();
  assert.deepEqual(phase6EvidenceIssues(fixture.summary, fixture.documents), []);
});

test('phase-6 aggregate rejects a missing profile and selected=0 pointer', () => {
  const fixture = passingFixture();
  fixture.documents.delete('P7');
  fixture.summary.profiles.P3.selected = 0;
  const issues = phase6EvidenceIssues(fixture.summary, fixture.documents).join('; ');
  assert.match(issues, /P7 result document is missing/);
  assert.match(issues, /P3 summary selected is not recomputed from cases/);
});

test('phase-6 aggregate rejects artifact-only validated and inconclusive fixtures', () => {
  for (const status of ['validated', 'inconclusive']) {
    const fixture = passingFixture();
    fixture.documents.get('P6').cases[0].status = status;
    fixture.summary.profiles.P6.payloadSha256 = sha256CanonicalJson(fixture.documents.get('P6'));
    const issues = phase6EvidenceIssues(fixture.summary, fixture.documents).join('; ');
    assert.match(issues, new RegExp(`forbidden status ${status}`));
  }
});

test('phase-6 aggregate reports a malformed case collection instead of throwing', () => {
  const fixture = passingFixture();
  fixture.documents.get('P3').cases = { forged: true };
  fixture.summary.profiles.P3.payloadSha256 = sha256CanonicalJson(fixture.documents.get('P3'));
  assert.match(phase6EvidenceIssues(fixture.summary, fixture.documents).join('; '),
    /P3 cases must be an array/);
});

test('phase-6 aggregate rejects unknown execution differences', () => {
  const fixture = passingFixture();
  fixture.documents.get('P5').cases[0].comparison = {
    status: 'failed',
    classification: 'unexplained',
    mismatches: ['architectural-writes']
  };
  fixture.summary.profiles.P5.payloadSha256 = sha256CanonicalJson(fixture.documents.get('P5'));
  assert.match(phase6EvidenceIssues(fixture.summary, fixture.documents).join('; '),
    /comparison is unknown or inconclusive/);
});

test('phase-6 aggregate recomputes frozen identities, digests, stops, and native final state', () => {
  const fixture = passingFixture();
  const entry = fixture.documents.get('P4').cases[0];
  entry.id = 'EXEC-P4-FORGED';
  entry.image.marsFingerprint = '2'.repeat(64);
  entry.legacy.stop.instructions++;
  entry.builtin.nativeFinalState.gpr[1] = '0x00000001';
  fixture.summary.profiles.P4.payloadSha256 = sha256CanonicalJson(fixture.documents.get('P4'));
  const issues = phase6EvidenceIssues(fixture.summary, fixture.documents).join('; ');
  assert.match(issues, /case IDs do not exactly match the frozen corpus/);
  assert.match(issues, /image fingerprints do not match/);
  assert.match(issues, /matched comparison contains unequal evidence/);
  assert.match(issues, /native final state disagrees with its trace/);
});
