import * as fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSeedCases, buildSeedManifest, serializedSeedManifest } from '../corpus/generate-seeds.mjs';
import { renderSeedProgram, seedMnemonicsByProfile, seedRendererRevision } from '../corpus/seed-program-renderer.mjs';
import { featureDistributionPayload, validateFeatureDistribution } from '../corpus/verify-corpus-freeze.mjs';

test('fixed seed expansion is explicit, balanced, deterministic, and bounded', () => {
  const first = buildSeedCases();
  const second = buildSeedCases();
  assert.deepEqual(first, second);
  assert.equal(first.length, 250);
  for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7']) {
    assert.equal(first.filter((entry) => entry.profile === profile).length, 50);
  }
  assert.equal(new Set(first.map((entry) => entry.id)).size, first.length);
  assert.equal(new Set(first.map((entry) => entry.seed)).size, first.length);
  assert.ok(first.every((entry) => entry.sourceWordLimit === 4096 && entry.runnerRevision === 1 && entry.rendererRevision === seedRendererRevision));
  assert.ok(first.every((entry) => /^[0-9a-f]{64}$/.test(entry.sourceSha256) && /^[0-9a-f]{64}$/.test(entry.imageSha256)));
  assert.equal(new Set(first.map((entry) => entry.sourceSha256)).size, 250);
  assert.equal(new Set(first.map((entry) => entry.imageSha256)).size, 250);
  assert.match(serializedSeedManifest(), /"casesSha256": "[0-9a-f]{64}"/);
  assert.equal(buildSeedManifest().batch.countPerProfile, 50);
  assert.equal(buildSeedManifest().schemaRevision, 3);
});

test('every fixed seed materializes real deterministic source and image words', () => {
  const cases = buildSeedCases();
  for (const seedCase of cases) {
    const first = renderSeedProgram(seedCase);
    const second = renderSeedProgram(seedCase);
    assert.deepEqual(first, second);
    assert.equal(first.sourceSha256, seedCase.sourceSha256);
    assert.equal(first.imageSha256, seedCase.imageSha256);
    assert.equal(first.words.length, seedCase.imageWordCount);
    assert.match(first.source, /^# SEED-P[3-7]-\d{4};/);
    assert.match(first.source, /\.text 0x00003000/);
    assert.match(first.source, /_halt:\nbeq \$0, \$0,/);
    assert.deepEqual(
      [...new Set(first.instructions.filter((instruction) => instruction.role === undefined).map((instruction) => instruction.mnemonic))],
      seedMnemonicsByProfile[seedCase.profile]
    );
    assert.ok(first.words.every((word) => /^0x[0-9a-f]{8}$/.test(word)));
  }
});

test('feature distribution rejects weakened, duplicated, or stale gates', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../corpus/handwritten-feature-distribution.json', import.meta.url), 'utf8'));
  assert.equal(validateFeatureDistribution(manifest), manifest);

  const weakened = structuredClone(manifest);
  weakened.advertisedFeatures[0].minimumUniqueGraphs = 19;
  assert.throws(() => validateFeatureDistribution(weakened), /minimum must remain 20/);

  const duplicated = structuredClone(manifest);
  duplicated.advertisedFeatures.push(structuredClone(duplicated.advertisedFeatures[0]));
  assert.throws(() => validateFeatureDistribution(duplicated), /duplicate feature/);

  const payload = featureDistributionPayload(manifest);
  assert.equal(payload.integrity, undefined);
});
