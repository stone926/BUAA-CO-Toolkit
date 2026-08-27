#!/usr/bin/env node
/** Validate frozen seed and handwritten feature-distribution manifests. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializedSeedManifest } from './generate-seeds.mjs';
import { renderSeedProgram, seedMnemonicsByProfile, seedRendererRevision } from './seed-program-renderer.mjs';
import { loadEvidenceGates } from '../contract/validate-evidence-gates.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

function assert(condition, message) {
  if (!condition) throw new Error(`corpus freeze: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value)), 'utf8').digest('hex');
}

export function featureDistributionPayload(manifest) {
  const { integrity: _integrity, ...payload } = manifest;
  return payload;
}

export function validateFeatureDistribution(manifest) {
  assert(isObject(manifest) && manifest.schemaRevision === 1, 'feature distribution schemaRevision must be 1');
  const allowedRoot = ['schemaRevision', 'description', 'revision', 'eligibility', 'advertisedFeatures', 'criticalCombinations', 'revisionInvalidation', 'integrity'];
  assert(Object.keys(manifest).every((key) => allowedRoot.includes(key)), 'feature distribution has unknown root fields');
  assert(Number.isSafeInteger(manifest.revision) && manifest.revision > 0, 'feature distribution revision is invalid');
  assert(isObject(manifest.eligibility) && manifest.eligibility.minimumTotalUniqueGraphs === 500, 'handwritten total gate must remain 500');
  assert(Array.isArray(manifest.advertisedFeatures) && manifest.advertisedFeatures.length > 0, 'advertisedFeatures must be non-empty');
  const featureIds = new Set();
  for (const feature of manifest.advertisedFeatures) {
    assert(isObject(feature) && typeof feature.id === 'string' && /^[a-z0-9][a-z0-9.-]+$/.test(feature.id), 'feature ID is invalid');
    assert(!featureIds.has(feature.id), `duplicate feature ${feature.id}`);
    featureIds.add(feature.id);
    assert(feature.minimumUniqueGraphs === 20, `${feature.id} minimum must remain 20`);
  }
  assert(Array.isArray(manifest.criticalCombinations) && manifest.criticalCombinations.length > 0, 'criticalCombinations must be non-empty');
  const combinationIds = new Set();
  for (const combination of manifest.criticalCombinations) {
    assert(typeof combination.id === 'string' && !combinationIds.has(combination.id), 'combination ID is invalid/duplicated');
    combinationIds.add(combination.id);
    assert(Array.isArray(combination.features) && combination.features.length >= 2, `${combination.id} must combine at least two features`);
    assert(combination.features.every((id) => featureIds.has(id)), `${combination.id} references unknown features`);
    assert(combination.minimumUniqueGraphs === 5, `${combination.id} minimum must remain 5`);
  }
  assert(isObject(manifest.integrity) && manifest.integrity.algorithm === 'sha256-canonical-json-v1', 'feature distribution integrity algorithm is invalid');
  assert(manifest.integrity.payloadSha256 === hash(featureDistributionPayload(manifest)), 'feature distribution payload hash is stale');
  return manifest;
}

export function run() {
  const expectedSeeds = serializedSeedManifest();
  const actualSeeds = fs.readFileSync(path.join(root, 'seeds.json'), 'utf8').replace(/\r\n?/g, '\n');
  assert(actualSeeds === expectedSeeds, 'seeds.json is stale or hand-edited');
  const seedManifest = JSON.parse(actualSeeds);
  assert(seedManifest.schemaRevision === 3, 'seed schemaRevision must be 3');
  assert(seedManifest.batch.rendererRevision === seedRendererRevision, 'seed batch renderer revision is stale');
  const counts = Object.fromEntries(['P3', 'P4', 'P5', 'P6', 'P7'].map((profile) => [profile, seedManifest.cases.filter((entry) => entry.profile === profile).length]));
  assert(Object.values(counts).every((count) => count === 50), 'each profile must have exactly 50 fixed PR seeds');
  const distribution = validateFeatureDistribution(JSON.parse(fs.readFileSync(path.join(root, 'handwritten-feature-distribution.json'), 'utf8')));
  const contracts = JSON.parse(fs.readFileSync(path.join(root, '..', 'contract', 'contracts.json'), 'utf8'));
  const gates = loadEvidenceGates({ contracts, featureDistribution: distribution });
  const assemblyCapabilities = new Set(gates.document.evidenceKinds.find((kind) => kind.kind === 'assembly').capabilities.map((capability) => capability.id));
  const sourceHashes = new Set();
  const imageHashes = new Set();
  for (const seedCase of seedManifest.cases) {
    for (const field of gates.document.seedManifestFields) assert(Object.hasOwn(seedCase, field), `${seedCase.id} is missing frozen seed field ${field}`);
    const rendered = renderSeedProgram(seedCase);
    assert(rendered.sourceSha256 === seedCase.sourceSha256, `${seedCase.id} sourceSha256 is stale`);
    assert(rendered.imageSha256 === seedCase.imageSha256, `${seedCase.id} imageSha256 is stale`);
    assert(rendered.words.length === seedCase.imageWordCount, `${seedCase.id} imageWordCount is stale`);
    assert(rendered.rendererRevision === seedCase.rendererRevision, `${seedCase.id} rendererRevision is stale`);
    assert(rendered.evidenceCapabilityId === seedCase.evidenceCapabilityId && assemblyCapabilities.has(seedCase.evidenceCapabilityId), `${seedCase.id} evidence capability is invalid`);
    const requiredMnemonics = new Set(seedMnemonicsByProfile[seedCase.profile]);
    assert([...requiredMnemonics].every((mnemonic) => rendered.instructions.some((instruction) => instruction.mnemonic === mnemonic)), `${seedCase.id} does not render the complete required instruction set`);
    sourceHashes.add(rendered.sourceSha256);
    imageHashes.add(rendered.imageSha256);
  }
  assert(sourceHashes.size === seedManifest.cases.length, 'fixed seeds must render unique source graphs');
  assert(imageHashes.size === seedManifest.cases.length, 'fixed seeds must render unique images');
  process.stdout.write(`corpus freeze OK: seeds=${JSON.stringify(counts)}, renderedSources=${sourceHashes.size}, renderedImages=${imageHashes.size}, handwrittenFeatures=${distribution.advertisedFeatures.length}, combinations=${distribution.criticalCombinations.length}\n`);
  return 0;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedFile === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
