/**
 * Independent courseVector artifact validation and tiny directed oracles.
 *
 * This module deliberately imports neither MARS nor any production source,
 * generated ISA catalog, course-contract ledger, or CpuState implementation.
 * A MARS command therefore cannot create or overwrite course-correct expected
 * data. The only writer is expected/courseVector/manage-course-vectors.mjs.
 */
import * as crypto from 'node:crypto';
import * as fs from '../expected/guardedFs.mjs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGithubUsername } from '../governance/reviewerPolicy.mjs';
import {
  assertCandidateApproved,
  candidateDescriptor,
  sha256CanonicalJson
} from '../governance/approvalEnvelope.mjs';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
const conformanceRoot = path.resolve(runnerRoot, '..');
const corpusRoot = path.join(conformanceRoot, 'corpus');
const vectorRoot = path.join(conformanceRoot, 'expected', 'courseVector');
const tutorialSourceFile = path.join(corpusRoot, 'tutorial-refs', 'spec-excerpts.json');
const hex32Pattern = /^0x[0-9a-f]{8}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const idPattern = /^[A-Z0-9][A-Z0-9-]{2,127}$/;
const profiles = new Set(['P3', 'P4', 'P5', 'P6', 'P7']);
const vectorKinds = new Set(['program-final-state', 'cp0-sequence', 'timer-sequence', 'external-irq-sequence']);
const verificationModes = new Set(['mars-compatible-final-state', 'manual-final-state', 'independent-directed-oracle']);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`courseVector: ${message}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertOnlyKeys(value, allowed, context) {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  assert(unexpected.length === 0, `${context} has unknown fields: ${unexpected.join(', ')}`);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalSourceText(text) {
  return text.replace(/\r\n?/g, '\n');
}

export function sourceSha256(file) {
  return sha256Text(canonicalSourceText(fs.readFileSync(file, 'utf8')));
}

export function vectorPayload(vector) {
  return {
    schemaRevision: vector.schemaRevision,
    caseId: vector.caseId,
    profile: vector.profile,
    vectorKind: vector.vectorKind,
    source: vector.source,
    provenance: vector.provenance,
    execution: vector.execution,
    expected: vector.expected,
    observability: vector.observability
  };
}

export function vectorPayloadSha256(vector) {
  return sha256Text(canonicalJson(vectorPayload(vector)));
}

function validateHex32(value, context) {
  assert(typeof value === 'string' && hex32Pattern.test(value), `${context} must be lower-case 0x + 8 hex digits`);
}

function validateRegisterMap(value, context) {
  assert(isPlainObject(value), `${context} must be an object`);
  for (const [register, word] of Object.entries(value)) {
    assert(/^(?:0|[1-9]|[12][0-9]|3[01])$/.test(register), `${context} has invalid GPR ${register}`);
    validateHex32(word, `${context}.${register}`);
  }
}

function validateMemoryMap(value, context) {
  assert(isPlainObject(value), `${context} must be an object`);
  for (const [address, word] of Object.entries(value)) {
    validateHex32(address, `${context} address`);
    assert((Number.parseInt(address.slice(2), 16) & 3) === 0, `${context} address ${address} is not word aligned`);
    validateHex32(word, `${context}.${address}`);
  }
}

function validateFinalStateExpected(expected, context) {
  assertOnlyKeys(expected, ['kind', 'haltPc', 'haltWord', 'gpr', 'dm', 'writes'], context);
  assert(expected.kind === 'final-state', `${context}.kind must be final-state`);
  validateHex32(expected.haltPc, `${context}.haltPc`);
  validateHex32(expected.haltWord, `${context}.haltWord`);
  validateRegisterMap(expected.gpr, `${context}.gpr`);
  validateMemoryMap(expected.dm, `${context}.dm`);
  assert(isPlainObject(expected.writes), `${context}.writes must be an object`);
  assertOnlyKeys(expected.writes, ['gpr', 'dm'], `${context}.writes`);
  assert(Array.isArray(expected.writes.gpr) && Array.isArray(expected.writes.dm), `${context}.writes must contain arrays`);
  assert(new Set(expected.writes.gpr).size === expected.writes.gpr.length, `${context}.writes.gpr contains duplicates`);
  assert(new Set(expected.writes.dm).size === expected.writes.dm.length, `${context}.writes.dm contains duplicates`);
  for (const register of expected.writes.gpr) {
    assert(typeof register === 'string' && Object.hasOwn(expected.gpr, register), `${context}.writes.gpr ${register} lacks an expected value`);
  }
  for (const address of expected.writes.dm) {
    validateHex32(address, `${context}.writes.dm entry`);
    assert(Object.hasOwn(expected.dm, address), `${context}.writes.dm ${address} lacks an expected value`);
  }
}

function u32(value, context) {
  validateHex32(value, context);
  return Number.parseInt(value.slice(2), 16) >>> 0;
}

function h32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function cp0Snapshot(state) {
  return { status: h32(state.status), cause: h32(state.cause), epc: h32(state.epc), request: state.request };
}

function evaluateCp0Step(state, step, context) {
  assert(isPlainObject(step) && typeof step.op === 'string', `${context}.op is required`);
  if (step.op === 'reset') {
    assertOnlyKeys(step, ['op'], context);
    return { status: 0, cause: 0, epc: 0, request: false };
  }
  if (step.op === 'write-status') {
    assertOnlyKeys(step, ['op', 'value'], context);
    return { ...state, status: u32(step.value, `${context}.value`) & 0x0000fc03, request: false };
  }
  if (step.op === 'write-epc') {
    assertOnlyKeys(step, ['op', 'value'], context);
    return { ...state, epc: u32(step.value, `${context}.value`), request: false };
  }
  if (step.op === 'sample-hardware') {
    assertOnlyKeys(step, ['op', 'hwInt'], context);
    assert(Number.isInteger(step.hwInt) && step.hwInt >= 0 && step.hwInt <= 0x3f, `${context}.hwInt must be 6-bit`);
    return { ...state, cause: (state.cause & ~0x0000fc00) | (step.hwInt << 10), request: false };
  }
  if (step.op === 'request') {
    assertOnlyKeys(step, ['op', 'victimPc', 'delaySlot', 'exceptionCode', 'hwInt'], context);
    const victimPc = u32(step.victimPc, `${context}.victimPc`);
    assert(typeof step.delaySlot === 'boolean', `${context}.delaySlot must be boolean`);
    assert(Number.isInteger(step.exceptionCode) && [0, 4, 5, 8, 10, 12].includes(step.exceptionCode), `${context}.exceptionCode is outside the course set`);
    assert(Number.isInteger(step.hwInt) && step.hwInt >= 0 && step.hwInt <= 0x3f, `${context}.hwInt must be 6-bit`);
    const ip = step.hwInt << 10;
    const interrupt = (state.status & 1) !== 0 && (state.status & 2) === 0 && ((state.status & ip & 0x0000fc00) !== 0);
    const request = interrupt || (step.exceptionCode !== 0 && (state.status & 2) === 0);
    if (!request) {
      return { ...state, cause: (state.cause & ~0x0000fc00) | ip, request: false };
    }
    const code = interrupt ? 0 : step.exceptionCode;
    const cause = ip | (step.delaySlot ? 0x80000000 : 0) | (code << 2);
    return {
      status: state.status | 2,
      cause: cause >>> 0,
      epc: step.delaySlot ? (victimPc - 4) >>> 0 : victimPc,
      request: true
    };
  }
  if (step.op === 'eret') {
    assertOnlyKeys(step, ['op'], context);
    return { ...state, status: state.status & ~2, request: false };
  }
  throw new Error(`courseVector: ${context}.op is unknown: ${step.op}`);
}

function evaluateCp0Sequence(expected, context) {
  assertOnlyKeys(expected, ['kind', 'steps', 'snapshots'], context);
  assert(expected.kind === 'cp0-sequence', `${context}.kind must be cp0-sequence`);
  assert(Array.isArray(expected.steps) && expected.steps.length > 0, `${context}.steps must be non-empty`);
  assert(Array.isArray(expected.snapshots) && expected.snapshots.length === expected.steps.length, `${context}.snapshots length must equal steps`);
  let state = { status: 0, cause: 0, epc: 0, request: false };
  const actual = [];
  for (const [index, step] of expected.steps.entries()) {
    state = evaluateCp0Step(state, step, `${context}.steps[${index}]`);
    actual.push(cp0Snapshot(state));
  }
  assert(canonicalJson(actual) === canonicalJson(expected.snapshots), `${context}.snapshots do not match independent CP0 oracle`);
}

const timerStates = new Set(['IDLE', 'LOAD', 'CNT', 'INT']);

function timerSnapshot(state) {
  return {
    state: state.state,
    ctrl: h32(state.ctrl),
    preset: h32(state.preset),
    count: h32(state.count),
    irqLatched: state.irqLatched,
    irq: Boolean((state.ctrl & 8) && state.irqLatched)
  };
}

function evaluateTimerStep(state, step, context) {
  assert(isPlainObject(step) && typeof step.op === 'string', `${context}.op is required`);
  if (step.op === 'reset') {
    assertOnlyKeys(step, ['op'], context);
    return { state: 'IDLE', ctrl: 0, preset: 0, count: 0, irqLatched: false };
  }
  if (step.op === 'write') {
    assertOnlyKeys(step, ['op', 'register', 'value'], context);
    assert(['CTRL', 'PRESET', 'COUNT'].includes(step.register), `${context}.register is invalid`);
    const value = u32(step.value, `${context}.value`);
    if (step.register === 'CTRL') return { ...state, ctrl: value & 0xf };
    if (step.register === 'PRESET') return { ...state, preset: value };
    return { ...state, count: value };
  }
  if (step.op !== 'tick') {
    throw new Error(`courseVector: ${context}.op is unknown: ${step.op}`);
  }
  assertOnlyKeys(step, ['op'], context);
  if (state.state === 'IDLE') {
    return (state.ctrl & 1) ? { ...state, state: 'LOAD', irqLatched: false } : state;
  }
  if (state.state === 'LOAD') {
    return { ...state, state: 'CNT', count: state.preset };
  }
  if (state.state === 'CNT') {
    if (!(state.ctrl & 1)) return { ...state, state: 'IDLE' };
    if (state.count > 1) return { ...state, count: (state.count - 1) >>> 0 };
    return { ...state, state: 'INT', count: 0, irqLatched: true };
  }
  assert(timerStates.has(state.state), `${context} reached invalid timer state`);
  if ((state.ctrl & 6) === 0) {
    return { ...state, state: 'IDLE', ctrl: state.ctrl & ~1 };
  }
  return { ...state, state: 'IDLE', irqLatched: false };
}

function evaluateTimerSequence(expected, context) {
  assertOnlyKeys(expected, ['kind', 'steps', 'snapshots'], context);
  assert(expected.kind === 'timer-sequence', `${context}.kind must be timer-sequence`);
  assert(Array.isArray(expected.steps) && expected.steps.length > 0, `${context}.steps must be non-empty`);
  assert(Array.isArray(expected.snapshots) && expected.snapshots.length === expected.steps.length, `${context}.snapshots length must equal steps`);
  let state = { state: 'IDLE', ctrl: 0, preset: 0, count: 0, irqLatched: false };
  const actual = [];
  for (const [index, step] of expected.steps.entries()) {
    state = evaluateTimerStep(state, step, `${context}.steps[${index}]`);
    actual.push(timerSnapshot(state));
  }
  assert(canonicalJson(actual) === canonicalJson(expected.snapshots), `${context}.snapshots do not match the frozen official-Timer oracle`);
}

function evaluateExternalIrqSequence(expected, context) {
  assertOnlyKeys(expected, ['kind', 'steps', 'snapshots'], context);
  assert(expected.kind === 'external-irq-sequence', `${context}.kind must be external-irq-sequence`);
  assert(Array.isArray(expected.steps) && expected.steps.length > 0, `${context}.steps must be non-empty`);
  assert(Array.isArray(expected.snapshots) && expected.snapshots.length === expected.steps.length, `${context}.snapshots length must equal steps`);
  let asserted = false;
  const actual = [];
  for (const [index, step] of expected.steps.entries()) {
    const stepContext = `${context}.steps[${index}]`;
    assert(isPlainObject(step) && typeof step.op === 'string', `${stepContext}.op is required`);
    if (step.op === 'reset') {
      assertOnlyKeys(step, ['op'], stepContext);
      asserted = false;
    } else if (step.op === 'raise') {
      assertOnlyKeys(step, ['op'], stepContext);
      asserted = true;
    } else if (step.op === 'store') {
      assertOnlyKeys(step, ['op', 'address', 'byteEnable'], stepContext);
      const address = u32(step.address, `${stepContext}.address`) & 0xfffffffc;
      assert(Number.isInteger(step.byteEnable) && step.byteEnable >= 0 && step.byteEnable <= 15, `${stepContext}.byteEnable must be 4-bit`);
      if (asserted && address === 0x00007f20 && step.byteEnable !== 0) asserted = false;
    } else {
      throw new Error(`courseVector: ${stepContext}.op is unknown: ${step.op}`);
    }
    actual.push({ asserted });
  }
  assert(canonicalJson(actual) === canonicalJson(expected.snapshots), `${context}.snapshots do not match the independent external-IRQ oracle`);
}

function validateExpected(vector) {
  const context = `${vector.caseId}.expected`;
  assert(isPlainObject(vector.expected), `${context} must be an object`);
  if (vector.vectorKind === 'program-final-state') {
    validateFinalStateExpected(vector.expected, context);
  } else if (vector.vectorKind === 'cp0-sequence') {
    evaluateCp0Sequence(vector.expected, context);
  } else if (vector.vectorKind === 'timer-sequence') {
    evaluateTimerSequence(vector.expected, context);
  } else {
    evaluateExternalIrqSequence(vector.expected, context);
  }
}

export function loadTutorialSourceRegistry() {
  const registry = JSON.parse(fs.readFileSync(tutorialSourceFile, 'utf8'));
  assert(isPlainObject(registry), 'tutorial source registry root must be an object');
  assertOnlyKeys(registry, ['schemaRevision', 'description', 'sources', 'integrity'], 'tutorial source registry');
  assert(registry.schemaRevision === 1, 'tutorial source registry schemaRevision must be 1');
  assert(typeof registry.description === 'string' && registry.description.length > 0, 'tutorial source registry description is required');
  assert(Array.isArray(registry.sources) && registry.sources.length > 0, 'tutorial source registry sources must be non-empty');
  const ids = new Set();
  for (const [index, source] of registry.sources.entries()) {
    const context = `tutorial source registry.sources[${index}]`;
    assert(isPlainObject(source), `${context} must be an object`);
    assertOnlyKeys(source, ['id', 'path', 'lines', 'excerpt', 'excerptSha256', 'sourceRevision'], context);
    assert(typeof source.id === 'string' && idPattern.test(source.id), `${context}.id is invalid`);
    assert(!ids.has(source.id), `${context}.id is duplicated`);
    ids.add(source.id);
    assert(typeof source.path === 'string' && source.path.length > 0 && !path.isAbsolute(source.path), `${context}.path must be a portable locator`);
    assert(Array.isArray(source.lines) && source.lines.length === 2 && source.lines.every(Number.isSafeInteger) && source.lines[0] > 0 && source.lines[1] >= source.lines[0], `${context}.lines is invalid`);
    assert(typeof source.excerpt === 'string' && source.excerpt.length > 0, `${context}.excerpt is required`);
    assert(sha256Pattern.test(source.excerptSha256), `${context}.excerptSha256 is invalid`);
    assert(source.excerptSha256 === sha256Text(canonicalSourceText(source.excerpt)), `${context}.excerptSha256 is stale`);
    assert(Number.isSafeInteger(source.sourceRevision) && source.sourceRevision > 0, `${context}.sourceRevision is invalid`);
  }
  assert(isPlainObject(registry.integrity), 'tutorial source registry integrity is required');
  assertOnlyKeys(registry.integrity, ['algorithm', 'sourcesSha256'], 'tutorial source registry.integrity');
  assert(registry.integrity.algorithm === 'sha256-canonical-json-v1', 'tutorial source registry integrity algorithm is invalid');
  assert(sha256Pattern.test(registry.integrity.sourcesSha256), 'tutorial source registry sourcesSha256 is invalid');
  assert(registry.integrity.sourcesSha256 === sha256Text(canonicalJson(registry.sources)), 'tutorial source registry sourcesSha256 is stale');
  return { registry, byId: new Map(registry.sources.map((source) => [source.id, source])) };
}

function resolveVectorFile(relativeFile) {
  assert(typeof relativeFile === 'string' && /^[A-Z0-9][A-Z0-9-]{2,127}\.json$/.test(relativeFile), `invalid vector file name ${relativeFile}`);
  const file = path.resolve(vectorRoot, relativeFile);
  assert(isWithin(vectorRoot, file), `vector file escapes courseVector root: ${relativeFile}`);
  assert(fs.existsSync(file), `vector file is missing: ${relativeFile}`);
  const vectorRootReal = fs.realpathSync(vectorRoot);
  const fileReal = fs.realpathSync(file);
  assert(isWithin(vectorRootReal, fileReal), `vector file resolves outside courseVector root: ${relativeFile}`);
  assert(fs.statSync(fileReal).isFile(), `vector file is not a regular file: ${relativeFile}`);
  return fileReal;
}

export function validateCourseVector(vector, manifestCase, sourceRegistry = loadTutorialSourceRegistry()) {
  const context = manifestCase.caseId;
  assert(isPlainObject(vector), `${context} artifact must be an object`);
  assertOnlyKeys(vector, ['schemaRevision', 'caseId', 'profile', 'vectorKind', 'source', 'provenance', 'review', 'execution', 'expected', 'observability', 'integrity'], context);
  assert(vector.schemaRevision === 1, `${context}.schemaRevision must be 1`);
  assert(vector.caseId === manifestCase.caseId, `${context}.caseId does not match manifest`);
  assert(vector.profile === manifestCase.profile && profiles.has(vector.profile), `${context}.profile does not match manifest`);
  assert(vectorKinds.has(vector.vectorKind), `${context}.vectorKind is invalid`);

  assert(isPlainObject(vector.source), `${context}.source is required`);
  assertOnlyKeys(vector.source, ['corpusFile', 'sha256', 'hashNormalization'], `${context}.source`);
  assert(vector.source.corpusFile === manifestCase.file, `${context}.source.corpusFile does not match manifest`);
  assert(vector.source.hashNormalization === 'utf8-lf-v1', `${context}.source.hashNormalization is invalid`);
  assert(sha256Pattern.test(vector.source.sha256), `${context}.source.sha256 is invalid`);
  const sourceFile = path.resolve(corpusRoot, vector.source.corpusFile);
  assert(isWithin(corpusRoot, sourceFile), `${context}.source escapes corpus root`);
  assert(vector.source.sha256 === sourceSha256(sourceFile), `${context}.source.sha256 is stale`);

  assert(isPlainObject(vector.provenance), `${context}.provenance is required`);
  assertOnlyKeys(vector.provenance, ['derivation', 'contractIds', 'normativeSourceIds', 'sourceRegistrySha256', 'note', 'vectorRevision'], `${context}.provenance`);
  assert(['hand-computed', 'official-source-transcription'].includes(vector.provenance.derivation), `${context}.provenance.derivation is invalid`);
  assert(Array.isArray(vector.provenance.contractIds) && vector.provenance.contractIds.length > 0, `${context}.provenance.contractIds must be non-empty`);
  assert(new Set(vector.provenance.contractIds).size === vector.provenance.contractIds.length, `${context}.provenance.contractIds contains duplicates`);
  assert(vector.provenance.contractIds.every((id) => typeof id === 'string' && idPattern.test(id)), `${context}.provenance.contractIds contains an invalid ID`);
  assert(Array.isArray(vector.provenance.normativeSourceIds) && vector.provenance.normativeSourceIds.length > 0, `${context}.provenance.normativeSourceIds must be non-empty`);
  assert(new Set(vector.provenance.normativeSourceIds).size === vector.provenance.normativeSourceIds.length, `${context}.provenance.normativeSourceIds contains duplicates`);
  for (const id of vector.provenance.normativeSourceIds) {
    assert(sourceRegistry.byId.has(id), `${context}.provenance references unknown normative source ${id}`);
  }
  assert(sha256Pattern.test(vector.provenance.sourceRegistrySha256), `${context}.provenance.sourceRegistrySha256 is invalid`);
  assert(vector.provenance.sourceRegistrySha256 === sourceRegistry.registry.integrity.sourcesSha256, `${context}.provenance.sourceRegistrySha256 is stale`);
  assert(typeof vector.provenance.note === 'string' && vector.provenance.note.length > 0, `${context}.provenance.note is required`);
  assert(Number.isSafeInteger(vector.provenance.vectorRevision) && vector.provenance.vectorRevision > 0, `${context}.provenance.vectorRevision is invalid`);

  assert(isPlainObject(vector.review), `${context}.review is required`);
  assertOnlyKeys(vector.review, ['status', 'author', 'reviewer', 'reviewedAt', 'reviewRevision'], `${context}.review`);
  assert(vector.review.status === 'candidate', `${context}.review.status must remain candidate; approvals live in governance/approvals`);
  assert(isGithubUsername(vector.review.author), `${context}.review.author must be a GitHub username`);
  assert(vector.review.reviewer === null && vector.review.reviewedAt === null && vector.review.reviewRevision === 0, `${context}.candidate review fields must be null/null/0`);

  assert(isPlainObject(vector.execution), `${context}.execution is required`);
  assertOnlyKeys(vector.execution, ['verificationMode', 'initialState', 'stdin', 'interruptSchedule', 'stopCondition', 'stepLimit'], `${context}.execution`);
  assert(verificationModes.has(vector.execution.verificationMode), `${context}.execution.verificationMode is invalid`);
  if (vector.vectorKind === 'program-final-state') {
    assert(['mars-compatible-final-state', 'manual-final-state'].includes(vector.execution.verificationMode), `${context} program vector has incompatible verificationMode`);
  } else {
    assert(vector.execution.verificationMode === 'independent-directed-oracle', `${context} directed vector must use independent-directed-oracle`);
  }
  assert(isPlainObject(vector.execution.initialState), `${context}.execution.initialState must be an object`);
  assertOnlyKeys(vector.execution.initialState, ['gpr', 'dm', 'hi', 'lo', 'cp0'], `${context}.execution.initialState`);
  validateRegisterMap(vector.execution.initialState.gpr, `${context}.execution.initialState.gpr`);
  validateMemoryMap(vector.execution.initialState.dm, `${context}.execution.initialState.dm`);
  for (const field of ['hi', 'lo']) validateHex32(vector.execution.initialState[field], `${context}.execution.initialState.${field}`);
  assert(isPlainObject(vector.execution.initialState.cp0), `${context}.execution.initialState.cp0 must be an object`);
  for (const [register, word] of Object.entries(vector.execution.initialState.cp0)) {
    assert(['12', '13', '14'].includes(register), `${context}.execution.initialState.cp0 register ${register} is invalid`);
    validateHex32(word, `${context}.execution.initialState.cp0.${register}`);
  }
  assert(vector.execution.stdin === null, `${context}.execution.stdin must be null in phase 0 vectors`);
  assert(Array.isArray(vector.execution.interruptSchedule), `${context}.execution.interruptSchedule must be an array`);
  assert(isPlainObject(vector.execution.stopCondition) && typeof vector.execution.stopCondition.kind === 'string', `${context}.execution.stopCondition is invalid`);
  assert(Number.isSafeInteger(vector.execution.stepLimit) && vector.execution.stepLimit > 0, `${context}.execution.stepLimit is invalid`);

  validateExpected(vector);
  assert(isPlainObject(vector.observability), `${context}.observability is required`);
  assertOnlyKeys(vector.observability, ['maskRevision', 'definedFields', 'undefinedExcluded'], `${context}.observability`);
  assert(Number.isSafeInteger(vector.observability.maskRevision) && vector.observability.maskRevision > 0, `${context}.observability.maskRevision is invalid`);
  assert(Array.isArray(vector.observability.definedFields) && vector.observability.definedFields.length > 0, `${context}.observability.definedFields must be non-empty`);
  assert(Array.isArray(vector.observability.undefinedExcluded), `${context}.observability.undefinedExcluded must be an array`);

  assert(isPlainObject(vector.integrity), `${context}.integrity is required`);
  assertOnlyKeys(vector.integrity, ['algorithm', 'payloadSha256'], `${context}.integrity`);
  assert(vector.integrity.algorithm === 'sha256-canonical-json-v1', `${context}.integrity.algorithm is invalid`);
  assert(sha256Pattern.test(vector.integrity.payloadSha256), `${context}.integrity.payloadSha256 is invalid`);
  assert(vector.integrity.payloadSha256 === vectorPayloadSha256(vector), `${context}.integrity.payloadSha256 is stale`);
  return vector;
}

export function loadCourseVector(manifestCase, options = {}) {
  assert(typeof manifestCase.courseVector === 'string', `${manifestCase.caseId} has no courseVector artifact`);
  const file = resolveVectorFile(manifestCase.courseVector);
  const vector = validateCourseVector(JSON.parse(fs.readFileSync(file, 'utf8')), manifestCase, options.sourceRegistry);
  if (options.requireApproved) assertCourseVectorApproved(vector, file, options);
  return { vector, file };
}

export function courseVectorCandidateDescriptor(vector, file = resolveVectorFile(`${vector.caseId}.json`)) {
  validateCourseVector(vector, {
    caseId: vector.caseId,
    profile: vector.profile,
    file: vector.source.corpusFile
  });
  const descriptor = candidateDescriptor({
    artifactKind: 'courseVector',
    artifactId: vector.caseId,
    file,
    candidateAuthor: vector.review.author,
    candidateRevision: vector.provenance.vectorRevision
  });
  assert(descriptor.candidateSha256 === sha256CanonicalJson(vector), `${vector.caseId} differs from its candidate file`);
  return descriptor;
}

export function assertCourseVectorApproved(vector, file, options = {}) {
  if (!isPlainObject(vector) || vector.review?.status !== 'candidate') {
    throw new Error(`courseVector: ${vector?.caseId ?? '<unknown>'} is not a valid candidate`);
  }
  const subject = courseVectorCandidateDescriptor(vector, file ?? resolveVectorFile(`${vector.caseId}.json`));
  try {
    assertCandidateApproved(subject, options);
  } catch (error) {
    throw new Error(`courseVector: ${vector.caseId} is not independently approved: ${error instanceof Error ? error.message : String(error)}`);
  }
  return vector;
}

export function listCourseVectorJsonFiles() {
  return fs.readdirSync(vectorRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && idPattern.test(entry.name.replace(/\.json$/, '')) && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
}

export const courseVectorPaths = Object.freeze({ conformanceRoot, corpusRoot, vectorRoot, tutorialSourceFile });
