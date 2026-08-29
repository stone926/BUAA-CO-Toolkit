#!/usr/bin/env node
/**
 * Phase-6 reproducible execution differential.
 *
 * For every case the fixed legacy-course-executor dumps the exact text image
 * it executes. That image must first match the TS assembler image fingerprint;
 * only then are canonical architectural writes, exact stop evidence and final
 * observable summaries compared with machine.execute.
 */
import * as crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExecutionCorpusManifest } from '../corpus/generate-execution-corpus.mjs';
import { renderExecutionProgram } from '../corpus/execution-program-renderer.mjs';
import { canonicalJson, sha256CanonicalJson } from './canonicalJson.mjs';
import {
  assembleMarsReferenceImage,
  haltReached,
  legacyCourseExecutorRole,
  nativeCourseHaltReached,
  parseCoL2Trace,
  runMarsReference
} from './marsRunner.mjs';
import { referenceRoles, resolveVerifiedReference } from '../reference/referenceAssets.mjs';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(runnerRoot, '..');
const extensionRoot = path.resolve(conformanceRoot, '..', '..');
const corpusRoot = path.join(conformanceRoot, 'corpus');
const defaultCli = process.env.BUAA_CO_MIPS_ENGINE_CLI
  ?? path.join(extensionRoot, 'out', 'mips', 'cli', 'main.js');
const defaultOutputDirectory = path.resolve(conformanceRoot, '..', '.cache', 'phase6-execution-differential');
const profiles = Object.freeze(['P3', 'P4', 'P5', 'P6', 'P7']);
const profileSet = new Set(profiles);
const sha256Pattern = /^[0-9a-f]{64}$/;
const fixedWordPattern = /^0x[0-9a-f]{8}$/;
const forbiddenExecutionSource = /\b(?:j|jal|jr|jalr|syscall|break|eret|mfc0|mtc0)\b/i;

export const executionDifferentialSchemaRevision = 1;
export const executionDifferentialRunnerRevision = 1;
export const executionImageFingerprintRevision = 1;

function invariant(condition, message) {
  if (!condition) throw new Error(`execution differential: ${message}`);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function fixedWord(value) {
  if (typeof value === 'string' && /^0x[0-9a-f]{8}$/i.test(value)) return value.toLowerCase();
  invariant(Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff, `invalid 32-bit word ${value}`);
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeWordWithoutPrefix(value, label) {
  const token = String(value).replace(/^0x/i, '');
  invariant(/^[0-9a-f]{1,8}$/i.test(token), `${label} is not a 32-bit hex word: ${value}`);
  return token.toLowerCase().padStart(8, '0');
}

function readHexWords(file, label) {
  invariant(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), `${label} was not produced`);
  const normalized = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n').map((line) => line.trim()).filter(Boolean);
  invariant(lines.length > 0, `${label} is empty`);
  invariant(lines.every((line) => /^[0-9a-f]{8}$/i.test(line)), `${label} contains malformed HexText`);
  return lines.map((line) => `0x${line.toLowerCase()}`);
}

/** Source-graph-independent executable image identity shared with the MARS dump. */
export function executableImageFingerprint(words) {
  invariant(Array.isArray(words) && words.length > 0, 'image words must be a non-empty array');
  return sha256CanonicalJson({
    schemaRevision: executionImageFingerprintRevision,
    entryPc: '0x00003000',
    segments: [{
      name: 'text',
      baseAddress: '0x00003000',
      words: words.map(fixedWord)
    }]
  });
}

function tsTextWords(image, caseId) {
  invariant(image && Array.isArray(image.segments), `${caseId} TS assembler omitted ProgramImage segments`);
  const nonEmpty = image.segments.filter((segment) => Array.isArray(segment.words) && segment.words.length > 0);
  invariant(nonEmpty.length === 1 && nonEmpty[0].name === 'text' && nonEmpty[0].baseAddress === 0x3000,
    `${caseId} execution corpus must assemble to one non-empty text segment at 0x3000`);
  invariant(image.entryPc === 0x3000, `${caseId} TS entryPc is not 0x3000`);
  return nonEmpty[0].words.map(fixedWord);
}

function findHaltPc(words, caseId) {
  let index = -1;
  for (let cursor = 0; cursor + 1 < words.length; cursor++) {
    if (fixedWord(words[cursor]) === '0x1000ffff' && fixedWord(words[cursor + 1]) === '0x00000000') {
      index = cursor;
    }
  }
  invariant(index >= 0, `${caseId} has no final beq-self+nop halt pair`);
  invariant(index === words.length - 2, `${caseId} halt pair is not the final two image words`);
  return fixedWord(0x3000 + index * 4);
}

function parseTsWrites(lines, caseId) {
  invariant(Array.isArray(lines), `${caseId} TS executor omitted architectural trace`);
  return lines.map((line, index) => {
    let match = /^@([0-9a-f]{8}): \$([0-9]+) <= ([0-9a-f]{8})$/i.exec(line);
    if (match) {
      invariant(Number(match[2]) >= 0 && Number(match[2]) <= 31, `${caseId} TS trace line ${index + 1} has invalid GPR`);
      return {
        pc: `0x${match[1].toLowerCase()}`,
        kind: 'grf',
        target: String(Number(match[2])),
        value: `0x${match[3].toLowerCase()}`
      };
    }
    match = /^@([0-9a-f]{8}): \*([0-9a-f]{8}) <= ([0-9a-f]{8})$/i.exec(line);
    invariant(match, `${caseId} TS trace line ${index + 1} is malformed: ${line}`);
    return {
      pc: `0x${match[1].toLowerCase()}`,
      kind: 'dm',
      target: `0x${match[2].toLowerCase()}`,
      value: `0x${match[3].toLowerCase()}`
    };
  });
}

function marsWrites(blocks) {
  return blocks.flatMap((block) => block.events.map((event) => ({
    pc: `0x${normalizeWordWithoutPrefix(block.pc, 'MARS PC')}`,
    kind: event.kind,
    target: event.kind === 'grf'
      ? String(Number(event.target))
      : `0x${normalizeWordWithoutPrefix(event.target, 'MARS DM target')}`,
    value: `0x${normalizeWordWithoutPrefix(event.value, 'MARS value')}`
  })));
}

export function observableFinalSummary(writes) {
  const gpr = new Map();
  const dm = new Map();
  const writtenGpr = new Set();
  const writtenDm = new Set();
  for (const write of writes) {
    if (write.kind === 'grf') {
      gpr.set(write.target, write.value);
      writtenGpr.add(write.target);
    } else {
      dm.set(write.target, write.value);
      writtenDm.add(write.target);
    }
  }
  return {
    gpr: Object.fromEntries([...gpr].sort(([left], [right]) => Number(left) - Number(right))),
    dm: Object.fromEntries([...dm].sort(([left], [right]) => left.localeCompare(right))),
    writes: {
      gpr: [...writtenGpr].sort((left, right) => Number(left) - Number(right)),
      dm: [...writtenDm].sort()
    }
  };
}

function evidenceFromWrites(writes, stop, nativeDigest) {
  const finalSummary = observableFinalSummary(writes);
  return {
    instructions: stop.instructions,
    stop,
    writes,
    eventDigest: sha256CanonicalJson(writes),
    finalSummary,
    finalSummaryDigest: sha256CanonicalJson(finalSummary),
    ...(nativeDigest ? { nativeFinalStateDigest: nativeDigest } : {})
  };
}

function validateTsNativeFinalState(result, writes, caseId) {
  const state = result.finalState;
  invariant(state && Array.isArray(state.gpr) && state.gpr.length === 32,
    `${caseId} TS executor omitted the 32-register final state`);
  invariant(state.gpr.every((value) => fixedWordPattern.test(value)),
    `${caseId} TS executor returned a malformed final GPR`);
  invariant(fixedWordPattern.test(state.pc) && state.pc === result.haltPc,
    `${caseId} TS final PC does not equal the exact course halt PC`);
  invariant(fixedWordPattern.test(state.hi) && fixedWordPattern.test(state.lo)
    && typeof state.hiDefined === 'boolean' && typeof state.loDefined === 'boolean',
  `${caseId} TS executor returned malformed HI/LO final state`);
  invariant(Array.isArray(state.dataWords), `${caseId} TS executor omitted final data words`);

  const expectedGpr = Array(32).fill('0x00000000');
  const expectedData = new Map();
  for (const write of writes) {
    if (write.kind === 'grf') expectedGpr[Number(write.target)] = write.value;
    else expectedData.set(write.target, write.value);
  }
  invariant(canonicalJson(state.gpr) === canonicalJson(expectedGpr),
    `${caseId} TS final GPR state disagrees with the architectural trace`);
  const dataWords = state.dataWords.map((entry, index) => {
    invariant(entry && fixedWordPattern.test(entry.address) && fixedWordPattern.test(entry.value),
      `${caseId} TS final data word ${index + 1} is malformed`);
    return { address: entry.address, value: entry.value };
  }).sort((left, right) => left.address.localeCompare(right.address));
  invariant(new Set(dataWords.map((entry) => entry.address)).size === dataWords.length,
    `${caseId} TS final data state contains duplicate addresses`);
  const expectedDataWords = [...expectedData].map(([address, value]) => ({ address, value }))
    .sort((left, right) => left.address.localeCompare(right.address));
  invariant(canonicalJson(dataWords) === canonicalJson(expectedDataWords),
    `${caseId} TS final data state disagrees with the architectural trace`);
  invariant(sha256Pattern.test(result.finalStateDigest ?? ''), `${caseId} TS finalStateDigest is malformed`);
  invariant(sha256Pattern.test(result.imageFingerprint ?? ''), `${caseId} TS execution imageFingerprint is malformed`);
  return {
    pc: state.pc,
    gpr: [...state.gpr],
    hi: state.hi,
    lo: state.lo,
    hiDefined: state.hiDefined,
    loDefined: state.loDefined,
    ...(state.cp0 === undefined ? {} : { cp0: { ...state.cp0 } }),
    dataWords
  };
}

let cachedExecutionContractIds;

function knownExecutionContractIds() {
  if (cachedExecutionContractIds) return cachedExecutionContractIds;
  const document = JSON.parse(fs.readFileSync(path.join(conformanceRoot, 'contract', 'divergences.json'), 'utf8'));
  invariant(document?.schemaRevision >= 1 && Array.isArray(document.entries), 'divergence ledger is malformed');
  cachedExecutionContractIds = new Set(
    document.entries.filter((entry) => entry.domain === 'execution').map((entry) => entry.id)
  );
  return cachedExecutionContractIds;
}

export function compareExecutionEvidence(caseRecord, legacy, builtin, contractIds = knownExecutionContractIds()) {
  const mismatches = [];
  if (canonicalJson(legacy.writes) !== canonicalJson(builtin.writes)) mismatches.push('architectural-writes');
  if (canonicalJson(legacy.stop) !== canonicalJson(builtin.stop)) mismatches.push('stop');
  if (canonicalJson(legacy.finalSummary) !== canonicalJson(builtin.finalSummary)) mismatches.push('final-summary');
  const expectedContractId = caseRecord.expectedDifferenceContractId;
  if (!mismatches.length) {
    return expectedContractId
      ? { status: 'failed', classification: 'unexplained', mismatches: [], message: `declared contract ${expectedContractId} was not observed` }
      : { status: 'passed', classification: 'matched', mismatches: [], message: 'canonical writes, stop and final summary match' };
  }
  if (typeof expectedContractId === 'string' && contractIds.has(expectedContractId)) {
    return {
      status: 'passed',
      classification: 'contract-difference',
      contractId: expectedContractId,
      mismatches,
      message: `known execution difference [${expectedContractId}]: ${mismatches.join(', ')}`
    };
  }
  return {
    status: 'failed',
    classification: 'unexplained',
    mismatches,
    message: `unexplained execution difference: ${mismatches.join(', ')}`
  };
}

function runTsCli(cli, requests) {
  invariant(fs.statSync(cli, { throwIfNoEntry: false })?.isFile(), `compiled TS CLI is missing: ${cli}`);
  const run = spawnSync(process.execPath, [cli], {
    cwd: extensionRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
  });
  if (run.error) throw run.error;
  invariant(run.status === 0, `TS CLI exited ${run.status}: ${(run.stderr ?? '').slice(0, 1000)}`);
  const responses = run.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  invariant(responses.length === requests.length, `TS CLI returned ${responses.length} responses for ${requests.length} requests`);
  const byId = new Map(responses.map((response) => [response.requestId, response]));
  invariant(byId.size === responses.length, 'TS CLI returned duplicate request IDs');
  return byId;
}

function loadCases() {
  const expected = buildExecutionCorpusManifest();
  const committed = JSON.parse(fs.readFileSync(path.join(corpusRoot, 'execution-corpus.json'), 'utf8'));
  invariant(canonicalJson(committed) === canonicalJson(expected), 'execution-corpus.json is stale');
  const cases = [];
  for (const entry of committed.generated) {
    const program = renderExecutionProgram(entry);
    invariant(program.sourceSha256 === entry.sourceSha256, `${entry.id} source hash mismatch`);
    invariant(program.imageSha256 === entry.imageSha256, `${entry.id} independent image hash mismatch`);
    invariant(program.haltPc === entry.haltPc && program.words.length === entry.imageWordCount, `${entry.id} frozen image metadata mismatch`);
    cases.push({ ...entry, kind: 'generated', source: program.source, independentWords: program.words });
  }
  for (const entry of committed.handwritten) {
    const file = path.resolve(corpusRoot, ...entry.file.split('/'));
    invariant(file.startsWith(`${path.resolve(corpusRoot, 'execution-handwritten')}${path.sep}`), `${entry.id} source escapes corpus`);
    const source = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
    invariant(sha256Text(source) === entry.sourceSha256, `${entry.id} source hash mismatch`);
    cases.push({ ...entry, kind: 'handwritten', source, independentWords: undefined });
  }
  invariant(cases.filter((entry) => entry.kind === 'generated').length === 250, 'generated case count is not 250');
  invariant(new Set(cases.map((entry) => entry.id)).size === cases.length, 'case IDs are not unique');
  const executionContractIds = knownExecutionContractIds();
  for (const entry of cases) {
    invariant(profileSet.has(entry.profile), `${entry.id} has unsupported profile ${entry.profile}`);
    invariant(!forbiddenExecutionSource.test(entry.source), `${entry.id} leaves the safe MARS-comparable execution domain`);
    invariant(entry.expectedDifferenceContractId === null
      || executionContractIds.has(entry.expectedDifferenceContractId), `${entry.id} declares an unknown execution contract`);
  }
  return { manifest: committed, cases };
}

function caseFailure(entry, status, message, extra = {}) {
  return {
    id: entry.id,
    profile: entry.profile,
    kind: entry.kind,
    status,
    message,
    ...extra
  };
}

function executeTsCases(cli, ready) {
  const requests = ready.map(({ entry, image, haltPc }) => ({
    protocolVersion: 1,
    requestId: `execute:${entry.id}`,
    operation: 'machine.execute',
    profile: entry.profile,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    segments: image.segments.map((segment) => ({
      name: segment.name,
      baseAddress: fixedWord(segment.baseAddress),
      words: segment.words.map(fixedWord)
    })),
    entryPc: fixedWord(image.entryPc),
    haltPc,
    maxSteps: entry.maxSteps,
    collectTrace: true
  }));
  return runTsCli(cli, requests);
}

function summarizeProfile(profile, results, reference, describe) {
  const selected = results.length;
  const count = (predicate) => results.filter(predicate).length;
  return {
    schemaRevision: executionDifferentialSchemaRevision,
    evidenceKind: 'real-execution-differential',
    profile,
    runnerRevision: executionDifferentialRunnerRevision,
    selected,
    generated: count((entry) => entry.kind === 'generated'),
    handwritten: count((entry) => entry.kind === 'handwritten'),
    passed: count((entry) => entry.status === 'passed'),
    explainedDifferences: count((entry) => entry.comparison?.classification === 'contract-difference'),
    unexplained: count((entry) => entry.comparison?.classification === 'unexplained'),
    failed: count((entry) => entry.status === 'failed'),
    inconclusive: count((entry) => entry.status === 'inconclusive'),
    outOfDomain: count((entry) => entry.status === 'out-of-domain'),
    error: count((entry) => entry.status === 'error'),
    reference: {
      role: reference.role,
      fileName: reference.fileName,
      sha256: reference.verifiedSha256,
      sourceTag: reference.sourceTag,
      sourceCommit: reference.sourceCommit
    },
    ts: {
      protocolVersion: 1,
      executor: describe.executor,
      assembler: describe.assembler,
      catalog: describe.catalog
    },
    cases: results
  };
}

function writeAtomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function runExecutionDifferential(options) {
  const cli = path.resolve(options.cli ?? defaultCli);
  const outputDirectory = path.resolve(options.outputDirectory ?? defaultOutputDirectory);
  const { manifest, cases } = loadCases();
  const reference = resolveVerifiedReference(referenceRoles.legacyCourseExecutor);
  invariant(reference.role === legacyCourseExecutorRole, 'resolved reference role is not legacy-course-executor');
  const describeResponse = runTsCli(cli, [{ protocolVersion: 1, requestId: 'describe', operation: 'describe' }]).get('describe');
  invariant(describeResponse?.ok === true && describeResponse.result?.executor?.id === 'builtin-ts-executor', 'TS CLI describe lacks the versioned executor');
  const describe = describeResponse.result;

  const assemblyRequests = cases.map((entry) => ({
    protocolVersion: 1,
    requestId: `assemble:${entry.id}`,
    operation: 'assembler.assemble',
    profile: entry.profile,
    sources: [{ id: 'source-0000', text: entry.source }]
  }));
  const assemblies = runTsCli(cli, assemblyRequests);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buaa-co-phase6-execution-'));
  const preliminary = new Map();
  const ready = [];
  try {
    for (const entry of cases) {
      const response = assemblies.get(`assemble:${entry.id}`);
      if (response?.ok !== true || response.result?.ok !== true || !response.result.image) {
        preliminary.set(entry.id, caseFailure(entry, 'error', `TS assembler failed: ${response?.error?.message ?? response?.result?.diagnostics?.[0]?.message ?? 'missing response'}`));
        continue;
      }
      let tsWords;
      let haltPc;
      try {
        tsWords = tsTextWords(response.result.image, entry.id);
        haltPc = findHaltPc(tsWords, entry.id);
        if (entry.kind === 'generated') {
          invariant(canonicalJson(tsWords) === canonicalJson(entry.independentWords), `${entry.id} TS image differs from the independent renderer`);
          invariant(haltPc === entry.haltPc, `${entry.id} TS haltPc differs from the frozen renderer`);
        }
      } catch (error) {
        preliminary.set(entry.id, caseFailure(entry, 'inconclusive', error instanceof Error ? error.message : String(error)));
        continue;
      }

      const asmFile = path.join(temporaryRoot, `${entry.id}.asm`);
      const dumpFile = path.join(temporaryRoot, `${entry.id}.text.hex`);
      fs.writeFileSync(asmFile, entry.source, 'utf8');
      const assemblyRun = assembleMarsReferenceImage({
        asmFile,
        profile: entry.profile,
        role: legacyCourseExecutorRole,
        dumpTextFile: dumpFile
      });
      if (!assemblyRun.ok) {
        preliminary.set(entry.id, caseFailure(entry, 'error', `fixed legacy assembler failed: ${assemblyRun.error ?? `exit ${assemblyRun.exitCode}`}`, {
          stderr: assemblyRun.stderr?.slice(0, 500)
        }));
        continue;
      }
      try {
        const marsImageWords = readHexWords(dumpFile, `${entry.id} fixed MARS text image`);
        const tsFingerprint = executableImageFingerprint(tsWords);
        const marsFingerprint = executableImageFingerprint(marsImageWords);
        invariant(sha256Pattern.test(response.result.image.fingerprint ?? ''),
          `${entry.id} TS assembler ProgramImage fingerprint is malformed`);
        invariant(tsFingerprint === marsFingerprint, `${entry.id} TS/MARS executable image fingerprints differ`);
        if (entry.kind === 'generated') {
          invariant(sha256Text(`${marsImageWords.map((word) => word.slice(2)).join('\n')}\n`) === entry.imageSha256,
            `${entry.id} fixed MARS image differs from the frozen independent image`);
        }
        const run = runMarsReference({
          asmFile,
          profile: entry.profile,
          maxSteps: entry.maxSteps,
          role: legacyCourseExecutorRole,
          haltPc
        });
        invariant(run.ok, `${entry.id} fixed legacy executor failed: ${run.error ?? `exit ${run.exitCode}`}`);
        const blocks = parseCoL2Trace(run.stdout);
        invariant(haltReached(blocks, haltPc, '0x1000ffff'), `${entry.id} MARS trace did not reach the exact halt`);
        invariant(nativeCourseHaltReached(run.stdout, haltPc), `${entry.id} MARS native halt marker is missing`);
        const writes = marsWrites(blocks);
        const stop = { kind: 'course-halt-loop', haltPc, haltWord: '0x1000ffff', instructions: blocks.length };
        ready.push({
          entry,
          image: response.result.image,
          haltPc,
          imageEvidence: {
            fingerprintRevision: executionImageFingerprintRevision,
            tsFingerprint,
            marsFingerprint,
            words: tsWords.length,
            matched: true,
            tsAssemblerProgramImageFingerprint: response.result.image.fingerprint,
            verifiedBeforeExecution: true,
            referenceRole: assemblyRun.role,
            referenceSha256: assemblyRun.reference.verifiedSha256
          },
          legacy: evidenceFromWrites(writes, stop),
          referenceRun: {
            role: run.role,
            referenceSha256: run.reference.verifiedSha256,
            effectiveMaxSteps: run.effectiveMaxSteps,
            cliOptions: run.cliOptions
          },
          assemblyRun: {
            role: assemblyRun.role,
            referenceSha256: assemblyRun.reference.verifiedSha256,
            cliOptions: assemblyRun.cliOptions
          }
        });
      } catch (error) {
        preliminary.set(entry.id, caseFailure(entry, 'inconclusive', error instanceof Error ? error.message : String(error)));
      }
    }

    const executions = ready.length ? executeTsCases(cli, ready) : new Map();
    for (const item of ready) {
      const response = executions.get(`execute:${item.entry.id}`);
      if (response?.ok !== true || !response.result) {
        preliminary.set(item.entry.id, caseFailure(item.entry, 'error', `TS executor request failed: ${response?.error?.message ?? 'missing response'}`, {
          image: item.imageEvidence,
          legacy: item.legacy
        }));
        continue;
      }
      const result = response.result;
      if (result.diagnostic) {
        preliminary.set(item.entry.id, caseFailure(item.entry, 'out-of-domain', `TS executor diagnostic [${result.diagnostic.code}]: ${result.diagnostic.message ?? result.diagnostic.reason ?? 'unknown'}`, {
          contractId: result.diagnostic.contractId,
          image: item.imageEvidence,
          legacy: item.legacy
        }));
        continue;
      }
      if (result.status !== 'halted' || result.haltReason !== 'course-halt-loop'
        || result.haltPc?.toLowerCase() !== item.haltPc) {
        preliminary.set(item.entry.id, caseFailure(item.entry, 'inconclusive', `TS executor did not prove the exact halt: ${result.status ?? 'missing'} ${result.haltPc ?? ''}`.trim(), {
          image: item.imageEvidence,
          legacy: item.legacy
        }));
        continue;
      }
      try {
        const writes = parseTsWrites(result.trace, item.entry.id);
        const nativeFinalState = validateTsNativeFinalState(result, writes, item.entry.id);
        const stop = {
          kind: 'course-halt-loop',
          haltPc: item.haltPc,
          haltWord: '0x1000ffff',
          instructions: result.instructions
        };
        invariant(Number.isSafeInteger(result.instructions) && result.instructions > 0, `${item.entry.id} TS instruction summary is invalid`);
        const builtin = evidenceFromWrites(writes, stop, result.finalStateDigest);
        builtin.nativeFinalState = nativeFinalState;
        builtin.executionImageFingerprint = result.imageFingerprint;
        const comparison = compareExecutionEvidence(item.entry, item.legacy, builtin);
        preliminary.set(item.entry.id, caseFailure(item.entry, comparison.status, comparison.message, {
          image: item.imageEvidence,
          legacy: item.legacy,
          builtin,
          comparison,
          assemblyRun: item.assemblyRun,
          referenceRun: item.referenceRun
        }));
      } catch (error) {
        preliminary.set(item.entry.id, caseFailure(item.entry, 'inconclusive', error instanceof Error ? error.message : String(error), {
          image: item.imageEvidence,
          legacy: item.legacy
        }));
      }
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const perProfile = {};
  for (const profile of profiles) {
    const results = cases.filter((entry) => entry.profile === profile).map((entry) => {
      const result = preliminary.get(entry.id);
      return result ?? caseFailure(entry, 'error', 'case produced no differential result');
    });
    perProfile[profile] = summarizeProfile(profile, results, reference, describe);
    writeAtomicJson(path.join(outputDirectory, `${profile}.json`), perProfile[profile]);
  }
  const allResults = Object.values(perProfile).flatMap((entry) => entry.cases);
  const summary = {
    schemaRevision: executionDifferentialSchemaRevision,
    evidenceKind: 'real-execution-differential-summary',
    batchId: manifest.batch.id,
    corpusPayloadSha256: manifest.integrity.payloadSha256,
    runnerRevision: executionDifferentialRunnerRevision,
    generatedRequired: 250,
    profilesRequired: profiles,
    selected: allResults.length,
    generated: allResults.filter((entry) => entry.kind === 'generated').length,
    handwritten: allResults.filter((entry) => entry.kind === 'handwritten').length,
    passed: allResults.filter((entry) => entry.status === 'passed').length,
    explainedDifferences: allResults.filter((entry) => entry.comparison?.classification === 'contract-difference').length,
    unexplained: allResults.filter((entry) => entry.comparison?.classification === 'unexplained').length,
    failed: allResults.filter((entry) => entry.status === 'failed').length,
    inconclusive: allResults.filter((entry) => entry.status === 'inconclusive').length,
    outOfDomain: allResults.filter((entry) => entry.status === 'out-of-domain').length,
    error: allResults.filter((entry) => entry.status === 'error').length,
    profiles: Object.fromEntries(profiles.map((profile) => [profile, {
      file: `${profile}.json`,
      selected: perProfile[profile].selected,
      generated: perProfile[profile].generated,
      handwritten: perProfile[profile].handwritten,
      passed: perProfile[profile].passed,
      explainedDifferences: perProfile[profile].explainedDifferences,
      unexplained: perProfile[profile].unexplained,
      failed: perProfile[profile].failed,
      inconclusive: perProfile[profile].inconclusive,
      outOfDomain: perProfile[profile].outOfDomain,
      error: perProfile[profile].error,
      payloadSha256: sha256CanonicalJson(perProfile[profile])
    }]))
  };
  writeAtomicJson(path.join(outputDirectory, 'summary.json'), summary);
  return { summary, outputDirectory };
}

function parseArgs(argv) {
  const options = { cli: defaultCli, outputDirectory: defaultOutputDirectory };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--cli') options.cli = argv[++index];
    else if (arg === '--output-dir') options.outputDirectory = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
    invariant(options.cli && options.outputDirectory, `${arg} requires a value`);
  }
  return { cli: path.resolve(options.cli), outputDirectory: path.resolve(options.outputDirectory) };
}

function main() {
  const { summary, outputDirectory } = runExecutionDifferential(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ type: 'phase6-execution-differential', outputDirectory, ...summary })}\n`);
  if (summary.generated !== 250 || summary.selected === 0 || summary.failed > 0
    || summary.inconclusive > 0 || summary.outOfDomain > 0 || summary.error > 0
    || summary.unexplained > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
