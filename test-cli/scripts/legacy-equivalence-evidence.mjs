import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const expectedProfiles = Object.freeze(['P3', 'P5', 'P7']);
export const expectedScenarios = Object.freeze(['success', 'assembly-failure']);

export function readLaneManifest(file, schemaVersion, implementation) {
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assertEvidence(manifest?.schemaVersion === schemaVersion, `${implementation}: unsupported lane manifest schema`);
  assertEvidence(manifest.implementation === implementation, `${implementation}: implementation marker mismatch`);
  assertEvidence(Array.isArray(manifest.cases), `${implementation}: cases must be an array`);
  return manifest;
}

export function compareLanes({ baselineManifest, currentManifest, baselineArtifacts, currentArtifacts, references }) {
  const baselineCases = indexCases(baselineManifest.cases, 'baseline');
  const currentCases = indexCases(currentManifest.cases, 'current');
  const expectedIds = references.flatMap((reference) => expectedProfiles.flatMap((profile) =>
    expectedScenarios.map((scenario) => caseId(reference.role, profile, scenario))
  ));
  assertEvidence(baselineCases.size === expectedIds.length, `baseline emitted ${baselineCases.size} cases, expected ${expectedIds.length}`);
  assertEvidence(currentCases.size === expectedIds.length, `current emitted ${currentCases.size} cases, expected ${expectedIds.length}`);

  return expectedIds.map((id) => {
    const oldCase = baselineCases.get(id);
    const providerCase = currentCases.get(id);
    assertEvidence(oldCase && providerCase, `${id}: missing from one or both lanes`);
    const reference = references.find((item) => item.role === oldCase.role);
    assertEvidence(reference, `${id}: unknown reference role`);
    validateCaseIdentity(oldCase, id, reference.verifiedSha256);
    validateCaseIdentity(providerCase, id, reference.verifiedSha256);
    assertEvidence(oldCase.profile === providerCase.profile && oldCase.scenario === providerCase.scenario, `${id}: case identity differs`);
    assertEvidence(oldCase.expectedVerdict === expectedVerdict(oldCase.scenario), `${id}: baseline expected verdict marker is wrong`);
    assertEvidence(providerCase.expectedVerdict === expectedVerdict(providerCase.scenario), `${id}: current expected verdict marker is wrong`);
    assertEvidence(oldCase.verdict === oldCase.expectedVerdict, `${id}: baseline verdict ${oldCase.verdict} did not meet ${oldCase.expectedVerdict}`);
    assertEvidence(providerCase.verdict === providerCase.expectedVerdict, `${id}: provider verdict ${providerCase.verdict} did not meet ${providerCase.expectedVerdict}`);
    assertEvidence(oldCase.engineSha256 === reference.verifiedSha256, `${id}: baseline executed an unexpected engine`);
    assertEvidence(providerCase.engineSha256 === reference.verifiedSha256, `${id}: provider executed an unexpected engine`);

    const oldMachine = readAndVerifyArtifact(baselineArtifacts, oldCase.machineCode, `${id}: baseline machine`);
    const newMachine = readAndVerifyArtifact(currentArtifacts, providerCase.machineCode, `${id}: provider machine`);
    const oldTrace = readAndVerifyArtifact(baselineArtifacts, oldCase.trace, `${id}: baseline trace`);
    const newTrace = readAndVerifyArtifact(currentArtifacts, providerCase.trace, `${id}: provider trace`);
    const machineCodeEqual = optionalBuffersEqual(oldMachine, newMachine);
    const traceEqual = optionalBuffersEqual(oldTrace, newTrace);
    const verdictEqual = oldCase.verdict === providerCase.verdict;
    const haltPcEqual = oldCase.haltPc === providerCase.haltPc;
    assertEvidence(machineCodeEqual, `${id}: machine-code bytes differ`);
    assertEvidence(traceEqual, `${id}: trace bytes differ`);
    assertEvidence(verdictEqual, `${id}: verdict differs`);
    assertEvidence(haltPcEqual, `${id}: halt PC differs`);
    if (oldCase.scenario === 'success') {
      assertEvidence(oldMachine && oldTrace && oldCase.haltPc !== null, `${id}: success case lacks machine code, trace, or halt PC`);
    } else {
      assertEvidence(oldTrace === undefined && newTrace === undefined, `${id}: assembly failure unexpectedly emitted a trace`);
      assertEvidence(oldCase.haltPc === null && providerCase.haltPc === null, `${id}: assembly failure unexpectedly emitted a halt PC`);
    }

    return {
      caseId: id,
      role: oldCase.role,
      profile: oldCase.profile,
      scenario: oldCase.scenario,
      expectedVerdict: oldCase.expectedVerdict,
      baseline: caseEvidence(oldCase),
      provider: caseEvidence(providerCase),
      equality: { machineCodeBytes: true, traceBytes: true, verdict: true, haltPc: true }
    };
  });
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function assertEvidence(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function indexCases(cases, lane) {
  const indexed = new Map();
  for (const item of cases) {
    assertEvidence(item && typeof item.caseId === 'string' && !indexed.has(item.caseId), `${lane}: invalid or duplicate case id`);
    indexed.set(item.caseId, item);
  }
  return indexed;
}

function validateCaseIdentity(item, expectedId, referenceSha256) {
  assertEvidence(item.caseId === expectedId, `${expectedId}: case id mismatch`);
  assertEvidence(expectedProfiles.includes(item.profile), `${expectedId}: unsupported profile`);
  assertEvidence(expectedScenarios.includes(item.scenario), `${expectedId}: unsupported scenario`);
  assertEvidence(caseId(item.role, item.profile, item.scenario) === expectedId, `${expectedId}: role/profile/scenario do not match the case id`);
  assertEvidence(item.referenceSha256 === referenceSha256, `${expectedId}: reference digest marker mismatch`);
  assertEvidence(['passed', 'failed'].includes(item.verdict), `${expectedId}: invalid verdict`);
  assertEvidence(item.haltPc === null || /^0x[0-9a-f]{8}$/.test(item.haltPc), `${expectedId}: invalid halt PC`);
  assertEvidence(item.machineCode?.relativePath === `cases/${expectedId}/machine.txt`, `${expectedId}: unexpected machine-code artifact path`);
  assertEvidence(item.trace?.relativePath === `cases/${expectedId}/trace.txt`, `${expectedId}: unexpected trace artifact path`);
}

function readAndVerifyArtifact(root, descriptor, label) {
  assertEvidence(descriptor && typeof descriptor.relativePath === 'string', `${label}: missing artifact descriptor`);
  assertEvidence(!path.isAbsolute(descriptor.relativePath) && !descriptor.relativePath.includes('\\'), `${label}: invalid relative path`);
  const resolved = path.resolve(root, descriptor.relativePath);
  assertEvidence(isWithin(root, resolved), `${label}: artifact path escapes lane root`);
  if (!descriptor.present) {
    assertEvidence(descriptor.bytes === 0 && descriptor.sha256 === null && !fs.existsSync(resolved), `${label}: absent descriptor does not match disk`);
    return undefined;
  }
  const stat = fs.lstatSync(resolved);
  assertEvidence(stat.isFile() && !stat.isSymbolicLink(), `${label}: artifact is not a regular non-symlink file`);
  const bytes = fs.readFileSync(resolved);
  assertEvidence(descriptor.bytes === bytes.byteLength, `${label}: byte length marker mismatch`);
  assertEvidence(descriptor.sha256 === sha256(bytes), `${label}: digest marker mismatch`);
  return bytes;
}

function caseEvidence(item) {
  return {
    verdict: item.verdict,
    haltPc: item.haltPc,
    machineCode: { present: item.machineCode.present, bytes: item.machineCode.bytes, sha256: item.machineCode.sha256 },
    trace: { present: item.trace.present, bytes: item.trace.bytes, sha256: item.trace.sha256 },
    assembleExitCode: item.assembleExitCode,
    executeExitCode: item.executeExitCode,
    engineSha256: item.engineSha256
  };
}

function expectedVerdict(scenario) {
  return scenario === 'success' ? 'passed' : 'failed';
}

function caseId(role, profile, scenario) {
  return `${role.replace(/[^a-zA-Z0-9._-]+/g, '-')}--${profile.toLowerCase()}--${scenario}`;
}

function optionalBuffersEqual(left, right) {
  return left === undefined || right === undefined ? left === right : left.equals(right);
}

function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
