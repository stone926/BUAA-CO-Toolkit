/**
 * course-vector lane: hand-reviewed expected values from the course contract.
 *
 * Program vectors assemble and execute through the production TS JSONL process
 * boundary, then compare with the independently reviewed expected artifact.
 * Directed device vectors use their corresponding versioned CLI operation.
 * A directed vector without a production CLI operation is reported explicitly
 * as artifact-only evidence instead of pretending that it exercised the TS core.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { corpusCaseFile } from '../caseManifest.mjs';
import { canonicalJson } from '../canonicalJson.mjs';
import { loadCourseVector, loadTutorialSourceRegistry, validateCourseVector } from '../courseVectorArtifact.mjs';
import { compareExpected, normalizedState, normalizedWrites } from '../stateOracle.mjs';

const defaultMaxSteps = 4096;
const laneRoot = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(laneRoot, '..', '..', '..', '..');
const defaultTsCli = path.join(extensionRoot, 'out', 'mips', 'cli', 'main.js');

export function runCourseVectorCase(manifestCase, options = {}) {
  const vector = options.vectorOverride
    ? validateCourseVector(options.vectorOverride, manifestCase, loadTutorialSourceRegistry())
    : loadCourseVector(manifestCase).vector;
  if (vector.vectorKind === 'program-final-state') {
    return runTsProgramVector(manifestCase, vector, options);
  }
  if (vector.vectorKind === 'timer-sequence') {
    return runTsTimerVector(manifestCase, vector, options);
  }
  if (vector.execution.verificationMode === 'independent-directed-oracle') {
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'validated',
      message: `artifact-only: no TS CLI operation exists for ${vector.vectorKind}; independent oracle matches the ${vector.review.status} artifact`,
      evidenceKind: 'directed-artifact-only',
      vectorPayloadSha256: vector.integrity.payloadSha256,
      reviewStatus: vector.review.status
    };
  }
  return {
    caseId: manifestCase.caseId,
    lane: 'course-vector',
    status: 'error',
    message: `unsupported course vector kind ${vector.vectorKind}`
  };
}

function runTsProgramVector(manifestCase, vector, options) {
  try {
    const source = fs.readFileSync(corpusCaseFile(manifestCase), 'utf8');
    const assembly = runTsCli([{
      protocolVersion: 1,
      requestId: `assemble:${manifestCase.caseId}`,
      operation: 'assembler.assemble',
      profile: manifestCase.profile,
      sources: [{ id: 'source-0000', text: source }]
    }], options).get(`assemble:${manifestCase.caseId}`);
    if (assembly?.ok !== true || assembly.result?.ok !== true || !assembly.result.image) {
      return laneFailure(manifestCase, 'error', `TS assembler failed: ${cliFailure(assembly)}`);
    }
    const image = assembly.result.image;
    const haltWord = imageWordAt(image, parseHex32(vector.expected.haltPc));
    if (fixedHex(haltWord) !== vector.expected.haltWord.toLowerCase()) {
      return laneFailure(manifestCase, 'failed',
        `assembled halt word differs: expected ${vector.expected.haltWord}, got ${fixedHex(haltWord)}`);
    }
    const execution = runTsCli([{
      protocolVersion: 1,
      requestId: `execute:${manifestCase.caseId}`,
      operation: 'machine.execute',
      profile: manifestCase.profile,
      enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
      segments: image.segments.map((segment) => ({
        name: segment.name,
        baseAddress: fixedHex(segment.baseAddress),
        words: segment.words.map(fixedHex)
      })),
      entryPc: fixedHex(image.entryPc),
      haltPc: vector.expected.haltPc,
      maxSteps: options.maxSteps ?? vector.execution.stepLimit ?? defaultMaxSteps,
      collectTrace: true
    }], options).get(`execute:${manifestCase.caseId}`);
    if (execution?.ok !== true) {
      return laneFailure(manifestCase, 'error', `TS executor failed: ${cliFailure(execution)}`);
    }
    const result = execution.result;
    if (result?.status !== 'halted' || result.haltReason !== 'course-halt-loop'
      || result.haltPc?.toLowerCase() !== vector.expected.haltPc.toLowerCase()) {
      return laneFailure(manifestCase, 'failed',
        `TS executor did not reach the exact halt: ${result?.status ?? 'missing result'} ${result?.haltPc ?? ''}`.trim());
    }
    const state = tsFinalState(result);
    const mismatches = compareExpected(vector.expected, state);
    if (mismatches.length) {
      return laneFailure(manifestCase, 'failed',
        `TS final state differs from course vector: ${mismatches.join('; ')}`);
    }
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'passed',
      message: `TS assembler/executor final state matches the ${vector.review.status} independent course vector`,
      evidenceKind: 'ts-cli-program-final-state',
      normalized: normalizedState(state),
      writes: normalizedWrites(state),
      finalStateDigest: result.finalStateDigest,
      imageFingerprint: result.imageFingerprint
    };
  } catch (error) {
    return laneFailure(manifestCase, 'error', error instanceof Error ? error.message : String(error));
  }
}

function runTsTimerVector(manifestCase, vector, options) {
  try {
    const steps = vector.expected.steps.map((step, index) => {
      if (step.op === 'reset') return { kind: 'reset' };
      if (step.op === 'tick') return { kind: 'tick', cycles: 1 };
      if (step.op === 'write' && (step.register === 'CTRL' || step.register === 'PRESET')) {
        return {
          kind: 'write', device: 'timer0', register: step.register.toLowerCase(), value: step.value
        };
      }
      throw new Error(`timer vector step ${index} cannot be represented by device.cycleVector`);
    });
    const response = runTsCli([{
      protocolVersion: 1,
      requestId: `timer:${manifestCase.caseId}`,
      operation: 'device.cycleVector',
      steps
    }], options).get(`timer:${manifestCase.caseId}`);
    if (response?.ok !== true || !Array.isArray(response.result)) {
      return laneFailure(manifestCase, 'error', `TS timer vector failed: ${cliFailure(response)}`);
    }
    const snapshots = response.result.map((observation) => ({
      state: String(observation.timer0?.state ?? '').toUpperCase(),
      ctrl: observation.timer0?.ctrl,
      preset: observation.timer0?.preset,
      count: observation.timer0?.count,
      irqLatched: observation.timer0?.pendingIrq,
      irq: observation.timer0?.irq
    }));
    if (canonicalJson(snapshots) !== canonicalJson(vector.expected.snapshots)) {
      const firstDiff = snapshots.findIndex((snapshot, index) =>
        canonicalJson(snapshot) !== canonicalJson(vector.expected.snapshots[index]));
      return laneFailure(manifestCase, 'failed',
        `TS timer snapshot differs at step ${firstDiff}: expected ${JSON.stringify(vector.expected.snapshots[firstDiff])}, got ${JSON.stringify(snapshots[firstDiff])}`);
    }
    return {
      caseId: manifestCase.caseId,
      lane: 'course-vector',
      status: 'passed',
      message: `TS device.cycleVector matches all ${snapshots.length} official Timer snapshots`,
      evidenceKind: 'ts-cli-timer-sequence',
      snapshots
    };
  } catch (error) {
    return laneFailure(manifestCase, 'error', error instanceof Error ? error.message : String(error));
  }
}

function runTsCli(requests, options) {
  const cli = path.resolve(options.cli ?? process.env.BUAA_CO_MIPS_ENGINE_CLI ?? defaultTsCli);
  if (!fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`compiled TS CLI is missing: ${cli}`);
  }
  const run = spawnSync(process.execPath, [cli], {
    cwd: extensionRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`TS CLI exited ${run.status}: ${run.stderr.slice(0, 500)}`);
  }
  const responses = run.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (responses.length !== requests.length) {
    throw new Error(`TS CLI returned ${responses.length} responses for ${requests.length} requests`);
  }
  const byId = new Map(responses.map((response) => [response.requestId, response]));
  if (byId.size !== responses.length || responses.some((response) => response.protocolVersion !== 1)) {
    throw new Error('TS CLI returned duplicate IDs or an unsupported protocol response');
  }
  return byId;
}

function tsFinalState(result) {
  if (!result.finalState || !Array.isArray(result.finalState.gpr)
    || !Array.isArray(result.finalState.dataWords) || !Array.isArray(result.trace)) {
    throw new Error('TS executor omitted final state or architectural trace');
  }
  const writtenGpr = new Set();
  const writtenDm = new Set();
  const traceValues = { gpr: new Map(), dm: new Map() };
  for (const [index, line] of result.trace.entries()) {
    let match = /^@[0-9a-f]{8}: \$([0-9]+) <= ([0-9a-f]{8})$/i.exec(line);
    if (match) {
      writtenGpr.add(match[1]);
      traceValues.gpr.set(match[1], match[2].toUpperCase());
      continue;
    }
    match = /^@[0-9a-f]{8}: \*([0-9a-f]{8}) <= ([0-9a-f]{8})$/i.exec(line);
    if (!match) throw new Error(`TS trace line ${index + 1} is malformed: ${line}`);
    writtenDm.add(match[1].toUpperCase());
    traceValues.dm.set(match[1].toUpperCase(), match[2].toUpperCase());
  }
  const gpr = new Map([...writtenGpr].map((register) => {
    const finalValue = normalizeCliWord(result.finalState.gpr[Number(register)], `GPR ${register}`);
    if (traceValues.gpr.get(register) !== finalValue) {
      throw new Error(`TS final GPR ${register} disagrees with its final trace write`);
    }
    return [register, finalValue];
  }));
  const finalDm = new Map(result.finalState.dataWords.map((entry) => [
    normalizeCliWord(entry.address, 'data address'), normalizeCliWord(entry.value, 'data value')
  ]));
  const dm = new Map([...writtenDm].map((address) => {
    const finalValue = finalDm.get(address);
    if (finalValue === undefined || traceValues.dm.get(address) !== finalValue) {
      throw new Error(`TS final DM ${address} disagrees with its final trace write`);
    }
    return [address, finalValue];
  }));
  return { gpr, dm, writtenGpr, writtenDm };
}

function imageWordAt(image, address) {
  for (const segment of image.segments ?? []) {
    const offset = address - segment.baseAddress;
    if (offset >= 0 && (offset & 3) === 0 && offset / 4 < segment.words.length) {
      return segment.words[offset / 4];
    }
  }
  return undefined;
}

function parseHex32(value) {
  return Number.parseInt(value.slice(2), 16) >>> 0;
}

function fixedHex(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
    ? `0x${(value >>> 0).toString(16).padStart(8, '0')}`
    : 'missing';
}

function normalizeCliWord(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{8}$/i.test(value)) {
    throw new Error(`TS ${label} is not a fixed-width word`);
  }
  return value.slice(2).toUpperCase();
}

function cliFailure(response) {
  return response?.error?.message ?? response?.result?.diagnostics?.[0]?.message ?? 'missing response';
}

function laneFailure(manifestCase, status, message) {
  return { caseId: manifestCase.caseId, lane: 'course-vector', status, message };
}
