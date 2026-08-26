import * as fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSeedCases, buildSeedManifest, serializedSeedManifest } from '../corpus/generate-seeds.mjs';
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
  assert.ok(first.every((entry) => entry.sourceWordLimit === 4096 && entry.runnerRevision === 1));
  assert.match(serializedSeedManifest(), /"casesSha256": "[0-9a-f]{64}"/);
  assert.equal(buildSeedManifest().batch.countPerProfile, 50);
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
