import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';

import {
  createEvidenceFingerprint,
  expandEvidenceBins,
  loadEvidenceGates,
  validateEvidenceFingerprint,
  validateEvidenceGateDocument
} from '../contract/validate-evidence-gates.mjs';

function fixtures() {
  return {
    document: JSON.parse(fs.readFileSync(new URL('../contract/evidence-gates.json', import.meta.url), 'utf8')),
    contracts: JSON.parse(fs.readFileSync(new URL('../contract/contracts.json', import.meta.url), 'utf8')),
    featureDistribution: JSON.parse(fs.readFileSync(new URL('../corpus/handwritten-feature-distribution.json', import.meta.url), 'utf8'))
  };
}

test('P3-P7 evidence capabilities expand to unique exact bins with numeric minima', () => {
  const fixture = fixtures();
  const validated = validateEvidenceGateDocument(fixture.document, fixture);
  assert.equal(validated.capabilities.size, 22);
  assert.equal(validated.bins.length, 589);
  assert.equal(new Set(validated.bins.map((bin) => bin.id)).size, validated.bins.length);
  assert.ok(validated.bins.every((bin) => Number.isSafeInteger(bin.minimum) && bin.minimum > 0));
  for (const profile of ['p3', 'p4', 'p5', 'p6', 'p7']) {
    assert.ok(validated.bins.some((bin) => bin.id === `execution.${profile}.instruction.nop`));
    assert.ok(validated.bins.some((bin) => bin.id === `full-stack.${profile}.graph.valid`));
  }
  assert.deepEqual(expandEvidenceBins(fixture.document), validated.bins);
});

test('evidence gate validator rejects weakened, missing, or ambiguous bins', () => {
  const fixture = fixtures();
  const weakened = structuredClone(fixture.document);
  weakened.evidenceKinds[0].capabilities[0].binGroups[0].minimumEach = 49999;
  assert.throws(() => validateEvidenceGateDocument(weakened, fixture), /must be 50000/);

  const incomplete = structuredClone(fixture.document);
  incomplete.memberSets.find((set) => set.id === 'isa.p7.required').members.pop();
  assert.throws(() => validateEvidenceGateDocument(incomplete, fixture), /exactly freeze the P7 required instruction order/);

  const ambiguous = structuredClone(fixture.document);
  ambiguous.evidenceKinds[0].capabilities[1].binGroups[0].idPrefix = ambiguous.evidenceKinds[0].capabilities[0].binGroups[0].idPrefix;
  assert.throws(() => validateEvidenceGateDocument(ambiguous, fixture), /not globally unique/);
});

test('fingerprints enforce kind-specific inclusion, exclusion, capability, and digest', () => {
  const validated = loadEvidenceGates(fixtures());
  const revisions = {
    semanticsRevision: 'semantics-r1',
    courseContractRevision: 'contracts-r1',
    corpusSchemaRevision: 'corpus-r3',
    capabilityScopeRevision: 'assembly.p3.source-image-r2',
    assemblerRevision: 'renderer-r1',
    catalogRevision: 'catalog-sha256-example',
    diagnosticSchemaRevision: 'diagnostic-r1'
  };
  const fingerprint = createEvidenceFingerprint(validated, 'assembly', 'assembly.p3.source-image', revisions);
  assert.equal(validateEvidenceFingerprint(validated, fingerprint).digest, fingerprint.digest);
  assert.throws(() => createEvidenceFingerprint(validated, 'assembly', 'execution.p3.architecture', revisions), /not a assembly capability/);
  assert.throws(() => createEvidenceFingerprint(validated, 'assembly', 'assembly.p3.source-image', { ...revisions, executorRevision: 'forbidden' }), /must be exactly/);
  assert.throws(() => validateEvidenceFingerprint(validated, { ...fingerprint, digest: '0'.repeat(64) }), /digest is stale/);
});
