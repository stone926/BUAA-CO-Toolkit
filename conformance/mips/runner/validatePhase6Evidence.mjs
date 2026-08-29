#!/usr/bin/env node
/** Fail-closed aggregate gate over real phase-6 execution run artifacts. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExecutionCorpusManifest } from '../corpus/generate-execution-corpus.mjs';
import { renderExecutionProgram } from '../corpus/execution-program-renderer.mjs';
import { loadReferenceManifest, referenceRoles } from '../reference/referenceAssets.mjs';
import { canonicalJson, sha256CanonicalJson } from './canonicalJson.mjs';
import {
  executableImageFingerprint,
  executionDifferentialSchemaRevision,
  executionDifferentialRunnerRevision
} from './executionDifferential.mjs';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(runnerRoot, '..');
const defaultExecutionDirectory = path.resolve(conformanceRoot, '..', '.cache', 'phase6-execution-differential');
const requiredProfiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
const sha256Pattern = /^[0-9a-f]{64}$/;
const divergenceLedger = JSON.parse(
  fs.readFileSync(path.join(conformanceRoot, 'contract', 'divergences.json'), 'utf8')
);
const knownExecutionContractIds = new Set(
  (divergenceLedger.entries ?? [])
    .filter((entry) => entry.domain === 'execution')
    .map((entry) => entry.id)
);
const expectedCorpus = buildExecutionCorpusManifest();
const expectedReference = loadReferenceManifest().assets.find(
  (entry) => entry.role === referenceRoles.legacyCourseExecutor
);
if (!expectedReference || expectedReference.status !== 'released') {
  throw new Error('phase6 aggregate: released legacy-course-executor is missing from reference manifest');
}
const expectedCases = new Map([
  ...expectedCorpus.generated.map((entry) => [entry.id, {
    ...entry,
    kind: 'generated',
    independentFingerprint: executableImageFingerprint(renderExecutionProgram(entry).words)
  }]),
  ...expectedCorpus.handwritten.map((entry) => [entry.id, { ...entry, kind: 'handwritten' }])
]);

function add(issues, condition, message) {
  if (!condition) issues.push(message);
}

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameCanonical(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function digestOf(value) {
  try {
    return sha256CanonicalJson(value);
  } catch {
    return undefined;
  }
}

function expectedAssemblyCli(profile) {
  return [
    'a', 'nc', 'mc', profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText', 'ae1',
    ...(['P5', 'P6', 'P7'].includes(profile) ? ['db'] : []),
    ...(profile === 'P7' ? ['efc'] : []),
    'dump', '.text', 'HexText', '<TEXT-IMAGE>', '<SOURCE>'
  ];
}

function expectedExecutionCli(profile, haltPc, maxSteps) {
  return [
    'nc', 'mc', profile === 'P7' ? 'CompactLargeText' : 'FixedCompactLargeText', 'ae1', 'se1',
    ...(['P5', 'P6', 'P7'].includes(profile) ? ['db'] : []),
    ...(profile === 'P7' ? ['efc'] : []),
    'coZeroGpr', 'coStrictData', `coHalt=${haltPc}`, 'coL2', String(maxSteps), '<SOURCE>'
  ];
}

function countsFor(cases) {
  const count = (predicate) => cases.filter(predicate).length;
  return {
    selected: cases.length,
    generated: count((entry) => entry.kind === 'generated'),
    handwritten: count((entry) => entry.kind === 'handwritten'),
    passed: count((entry) => entry.status === 'passed'),
    explainedDifferences: count((entry) => entry.comparison?.classification === 'contract-difference'),
    unexplained: count((entry) => entry.comparison?.classification === 'unexplained'),
    failed: count((entry) => entry.status === 'failed'),
    inconclusive: count((entry) => entry.status === 'inconclusive'),
    outOfDomain: count((entry) => entry.status === 'out-of-domain'),
    error: count((entry) => entry.status === 'error')
  };
}

export function phase6EvidenceIssues(summary, profileDocuments) {
  const issues = [];
  add(issues, summary && typeof summary === 'object', 'summary is missing or not an object');
  if (!summary || typeof summary !== 'object') return issues;
  add(issues, summary.schemaRevision === executionDifferentialSchemaRevision, 'summary schemaRevision is unsupported');
  add(issues, summary.runnerRevision === executionDifferentialRunnerRevision, 'summary runnerRevision is unsupported');
  add(issues, summary.evidenceKind === 'real-execution-differential-summary', 'summary is not real execution evidence');
  add(issues, summary.batchId === expectedCorpus.batch.id, 'summary batchId does not name the frozen execution corpus');
  add(issues, summary.corpusPayloadSha256 === expectedCorpus.integrity.payloadSha256,
    'summary corpus fingerprint does not match execution-corpus.json');
  add(issues, summary.generatedRequired === 250, 'summary generatedRequired must be 250');
  add(issues, summary.generated === 250, `real generated execution count must be 250, got ${summary.generated}`);
  add(issues, integer(summary.selected) && summary.selected > 0, 'selected execution count must be non-zero');
  add(issues, summary.selected === summary.generated + summary.handwritten, 'summary selected count does not close over generated+handwritten');
  add(issues, summary.unexplained === 0, `unexplained differential count must be zero, got ${summary.unexplained}`);
  add(issues, summary.failed === 0, `failed differential count must be zero, got ${summary.failed}`);
  add(issues, summary.inconclusive === 0, `inconclusive differential count must be zero, got ${summary.inconclusive}`);
  add(issues, summary.outOfDomain === 0, `out-of-domain differential count must be zero, got ${summary.outOfDomain}`);
  add(issues, summary.error === 0, `execution error count must be zero, got ${summary.error}`);
  add(issues, summary.passed === summary.selected, 'every selected real execution case must have status passed');
  add(issues, canonicalJson(summary.profilesRequired) === canonicalJson(requiredProfiles), 'required profile list is missing or changed');
  add(issues, sameCanonical(Object.keys(summary.profiles ?? {}).sort(), [...requiredProfiles].sort()),
    'summary profile pointers are not exactly P3-P7');

  const documents = profileDocuments instanceof Map
    ? profileDocuments
    : new Map(Object.entries(profileDocuments ?? {}));
  add(issues, sameCanonical([...documents.keys()].sort(), [...requiredProfiles].sort()),
    'result documents are not exactly P3-P7');
  const aggregateCases = [];
  const aggregateIds = new Set();
  for (const profile of requiredProfiles) {
    const pointer = summary.profiles?.[profile];
    const document = documents.get(profile);
    add(issues, pointer && typeof pointer === 'object', `${profile} summary pointer is missing`);
    add(issues, document && typeof document === 'object', `${profile} result document is missing`);
    if (!pointer || !document) continue;
    add(issues, sha256Pattern.test(pointer.payloadSha256 ?? ''), `${profile} payload fingerprint is missing`);
    add(issues, pointer.payloadSha256 === digestOf(document), `${profile} payload fingerprint does not match the real result document`);
    add(issues, document.schemaRevision === executionDifferentialSchemaRevision, `${profile} schemaRevision is unsupported`);
    add(issues, document.runnerRevision === executionDifferentialRunnerRevision, `${profile} runnerRevision is unsupported`);
    add(issues, document.evidenceKind === 'real-execution-differential', `${profile} is not a real execution result`);
    add(issues, document.profile === profile, `${profile} document profile mismatch`);
    add(issues, document.reference?.role === 'legacy-course-executor', `${profile} did not use fixed legacy-course-executor`);
    add(issues, document.reference?.sha256 === expectedReference.sha256
      && document.reference?.fileName === expectedReference.fileName
      && document.reference?.sourceTag === expectedReference.sourceTag
      && document.reference?.sourceCommit === expectedReference.sourceCommit,
    `${profile} fixed reference identity does not match reference-manifest.json`);
    add(issues, document.ts?.protocolVersion === 1
      && document.ts?.executor?.id === 'builtin-ts-executor'
      && document.ts?.assembler?.id === 'builtin-ts-assembler',
    `${profile} did not use the versioned TS assembler and machine.execute`);
    const cases = Array.isArray(document.cases) ? document.cases : [];
    add(issues, Array.isArray(document.cases), `${profile} cases must be an array`);
    const computed = countsFor(cases);
    for (const [field, value] of Object.entries(computed)) {
      add(issues, document[field] === value, `${profile} document ${field} is not recomputed from cases`);
      add(issues, pointer[field] === value, `${profile} summary ${field} is not recomputed from cases`);
    }
    add(issues, computed.selected > 0, `${profile} selected zero cases`);
    add(issues, computed.generated === 50, `${profile} must contain exactly 50 generated executions`);
    add(issues, computed.handwritten >= 1, `${profile} handwritten boundary execution is missing`);
    add(issues, computed.passed === computed.selected, `${profile} has non-passing selected executions`);
    for (const field of ['unexplained', 'failed', 'inconclusive', 'outOfDomain', 'error']) {
      add(issues, computed[field] === 0, `${profile} ${field} must be zero, got ${computed[field]}`);
    }
    const expectedProfileIds = [...expectedCases.values()]
      .filter((entry) => entry.profile === profile)
      .map((entry) => entry.id)
      .sort();
    const actualProfileIds = cases.map((entry) => entry?.id).sort();
    add(issues, sameCanonical(actualProfileIds, expectedProfileIds), `${profile} case IDs do not exactly match the frozen corpus`);
    add(issues, new Set(actualProfileIds).size === actualProfileIds.length, `${profile} contains duplicate case IDs`);
    for (const entry of cases) {
      if (!entry || typeof entry !== 'object') {
        issues.push(`${profile}/<missing> case is not an object`);
        continue;
      }
      const expected = expectedCases.get(entry.id);
      add(issues, expected !== undefined, `${profile}/${entry.id ?? '<missing>'} is not in the frozen corpus`);
      add(issues, entry.profile === profile, `${profile}/${entry.id ?? '<missing>'} profile mismatch`);
      add(issues, expected?.profile === entry.profile && expected?.kind === entry.kind,
        `${profile}/${entry.id ?? '<missing>'} kind/profile differs from the frozen corpus`);
      add(issues, entry.status === 'passed', `${profile}/${entry.id ?? '<missing>'} has forbidden status ${entry.status}`);
      add(issues, entry.status !== 'validated', `${profile}/${entry.id ?? '<missing>'} uses artifact-only validated status`);
      add(issues, entry.image?.matched === true, `${profile}/${entry.id ?? '<missing>'} lacks image equality proof`);
      add(issues, entry.image?.verifiedBeforeExecution === true
        && entry.image?.referenceRole === 'legacy-course-executor'
        && entry.image?.referenceSha256 === expectedReference.sha256,
      `${profile}/${entry.id ?? '<missing>'} image equality was not proven with the fixed reference before execution`);
      add(issues, sha256Pattern.test(entry.image?.tsFingerprint ?? '')
        && entry.image?.tsFingerprint === entry.image?.marsFingerprint,
      `${profile}/${entry.id ?? '<missing>'} TS/MARS image fingerprints do not match`);
      add(issues, sha256Pattern.test(entry.image?.tsAssemblerProgramImageFingerprint ?? ''),
        `${profile}/${entry.id ?? '<missing>'} TS assembler ProgramImage fingerprint is missing`);
      if (expected?.kind === 'generated') {
        add(issues, entry.image?.words === expected.imageWordCount
          && entry.image?.tsFingerprint === expected.independentFingerprint,
        `${profile}/${entry.id} image does not match the independent generated fingerprint`);
      } else {
        add(issues, integer(entry.image?.words) && entry.image.words > 0,
          `${profile}/${entry.id ?? '<missing>'} handwritten image word count is invalid`);
      }
      const legacyStop = entry.legacy?.stop;
      const builtinStop = entry.builtin?.stop;
      const validStop = (stop) => stop?.kind === 'course-halt-loop'
        && /^0x[0-9a-f]{8}$/.test(stop.haltPc ?? '')
        && stop.haltWord === '0x1000ffff'
        && Number.isSafeInteger(stop.instructions) && stop.instructions > 0;
      add(issues, validStop(legacyStop) && validStop(builtinStop),
        `${profile}/${entry.id ?? '<missing>'} exact stop evidence is missing`);
      if (expected?.kind === 'generated') {
        add(issues, legacyStop?.haltPc === expected.haltPc && builtinStop?.haltPc === expected.haltPc,
          `${profile}/${entry.id} stop PC differs from the frozen halt`);
      }
      add(issues, Array.isArray(entry.legacy?.writes) && Array.isArray(entry.builtin?.writes),
        `${profile}/${entry.id ?? '<missing>'} canonical writes are missing`);
      add(issues, entry.legacy?.eventDigest === digestOf(entry.legacy?.writes)
        && entry.builtin?.eventDigest === digestOf(entry.builtin?.writes),
      `${profile}/${entry.id ?? '<missing>'} canonical event digest is stale`);
      add(issues, entry.legacy?.finalSummaryDigest === digestOf(entry.legacy?.finalSummary)
        && entry.builtin?.finalSummaryDigest === digestOf(entry.builtin?.finalSummary),
      `${profile}/${entry.id ?? '<missing>'} final summary digest is stale`);

      const nativeState = entry.builtin?.nativeFinalState;
      const expectedNativeGpr = Array(32).fill('0x00000000');
      const expectedNativeData = new Map();
      for (const write of Array.isArray(entry.builtin?.writes) ? entry.builtin.writes : []) {
        if (write?.kind === 'grf' && Number.isInteger(Number(write.target))) {
          expectedNativeGpr[Number(write.target)] = write.value;
        } else if (write?.kind === 'dm') {
          expectedNativeData.set(write.target, write.value);
        }
      }
      const expectedNativeDataWords = [...expectedNativeData]
        .map(([address, value]) => ({ address, value }))
        .sort((left, right) => left.address.localeCompare(right.address));
      const actualNativeDataWords = Array.isArray(nativeState?.dataWords)
        ? [...nativeState.dataWords].sort((left, right) => String(left?.address).localeCompare(String(right?.address)))
        : undefined;
      add(issues, nativeState?.pc === builtinStop?.haltPc
        && sameCanonical(nativeState?.gpr, expectedNativeGpr)
        && sameCanonical(actualNativeDataWords, expectedNativeDataWords)
        && /^0x[0-9a-f]{8}$/.test(nativeState?.hi ?? '')
        && /^0x[0-9a-f]{8}$/.test(nativeState?.lo ?? '')
        && typeof nativeState?.hiDefined === 'boolean'
        && typeof nativeState?.loDefined === 'boolean',
      `${profile}/${entry.id ?? '<missing>'} TS native final state disagrees with its trace`);
      add(issues, sha256Pattern.test(entry.builtin?.nativeFinalStateDigest ?? '')
        && sha256Pattern.test(entry.builtin?.executionImageFingerprint ?? ''),
      `${profile}/${entry.id ?? '<missing>'} TS native final/image digest is missing`);

      const computedMismatches = [];
      if (!sameCanonical(entry.legacy?.writes, entry.builtin?.writes)) computedMismatches.push('architectural-writes');
      if (!sameCanonical(legacyStop, builtinStop)) computedMismatches.push('stop');
      if (!sameCanonical(entry.legacy?.finalSummary, entry.builtin?.finalSummary)) computedMismatches.push('final-summary');
      if (entry.comparison?.classification === 'matched') {
        add(issues, computedMismatches.length === 0 && sameCanonical(entry.comparison.mismatches, []),
          `${profile}/${entry.id ?? '<missing>'} matched comparison contains unequal evidence`);
        add(issues, expected?.expectedDifferenceContractId === null,
          `${profile}/${entry.id ?? '<missing>'} declared contract difference was not observed`);
      } else if (entry.comparison?.classification === 'contract-difference') {
        add(issues, computedMismatches.length > 0
          && sameCanonical(entry.comparison.mismatches, computedMismatches)
          && entry.comparison.contractId === expected?.expectedDifferenceContractId
          && knownExecutionContractIds.has(entry.comparison.contractId),
        `${profile}/${entry.id ?? '<missing>'} contract difference is not frozen for this case`);
      } else {
        issues.push(`${profile}/${entry.id ?? '<missing>'} comparison is unknown or inconclusive`);
      }

      add(issues, entry.assemblyRun?.role === 'legacy-course-executor'
        && entry.assemblyRun?.referenceSha256 === expectedReference.sha256
        && sameCanonical(entry.assemblyRun?.cliOptions, expectedAssemblyCli(profile)),
      `${profile}/${entry.id ?? '<missing>'} assembler-only fixed reference provenance is invalid`);
      add(issues, entry.referenceRun?.role === 'legacy-course-executor'
        && entry.referenceRun?.referenceSha256 === expectedReference.sha256
        && entry.referenceRun?.effectiveMaxSteps === expected?.maxSteps
        && sameCanonical(entry.referenceRun?.cliOptions,
          expectedExecutionCli(profile, legacyStop?.haltPc, expected?.maxSteps)),
      `${profile}/${entry.id ?? '<missing>'} fixed execution reference provenance is invalid`);
      if (typeof entry.id === 'string') {
        add(issues, !aggregateIds.has(entry.id), `${profile}/${entry.id} is duplicated across profile documents`);
        aggregateIds.add(entry.id);
      }
    }
    aggregateCases.push(...cases);
  }
  const aggregate = countsFor(aggregateCases);
  for (const [field, value] of Object.entries(aggregate)) {
    add(issues, summary[field] === value, `summary ${field} is not recomputed from profile cases`);
  }
  add(issues, sameCanonical([...aggregateIds].sort(), [...expectedCases.keys()].sort()),
    'aggregate case IDs do not exactly match the frozen corpus');
  return [...new Set(issues)];
}

function readEvidenceDirectory(directory) {
  const summaryFile = path.join(directory, 'summary.json');
  if (!fs.statSync(summaryFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`real execution summary is missing: ${summaryFile}`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  const profiles = new Map();
  for (const profile of requiredProfiles) {
    const relative = summary.profiles?.[profile]?.file;
    if (typeof relative !== 'string' || relative !== `${profile}.json`) continue;
    const file = path.resolve(directory, relative);
    if (path.dirname(file) !== directory || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    profiles.set(profile, JSON.parse(fs.readFileSync(file, 'utf8')));
  }
  return { summary, profiles };
}

export function validatePhase6EvidenceDirectory(directory = defaultExecutionDirectory) {
  const resolved = path.resolve(directory);
  const { summary, profiles } = readEvidenceDirectory(resolved);
  const issues = phase6EvidenceIssues(summary, profiles);
  if (issues.length) throw new Error(issues.join('; '));
  return {
    gate: 'phase6-real-execution-differential',
    status: 'passed',
    selected: summary.selected,
    generated: summary.generated,
    handwritten: summary.handwritten,
    profiles: requiredProfiles,
    unexplained: summary.unexplained
  };
}

function parseArgs(argv) {
  if (argv.length === 0) return defaultExecutionDirectory;
  if (argv.length === 2 && argv[0] === '--execution-dir' && argv[1] && !argv[1].startsWith('--')) {
    return path.resolve(argv[1]);
  }
  throw new Error('Usage: validatePhase6Evidence.mjs [--execution-dir <directory>]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = validatePhase6EvidenceDirectory(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`phase6 aggregate FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
