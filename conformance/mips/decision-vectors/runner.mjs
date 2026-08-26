import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { phase0ApprovalReviewer } from '../governance/reviewerPolicy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const expectedDecisionIds = new Set([
  'COURSE-P7-EXC-PRIORITY-001',
  'COURSE-P7-CP0-SAME-CYCLE-001',
  'COURSE-P7-TIMER-RESTART-001',
  'COURSE-P7-UNLOADED-IM-001'
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(relativeFile) {
  return JSON.parse(fs.readFileSync(path.join(here, relativeFile), 'utf8'));
}

function containedFile(relativeFile) {
  const resolved = path.resolve(here, relativeFile);
  const relative = path.relative(here, resolved);
  invariant(relative.length > 0 && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `decision-vector path escapes root: ${relativeFile}`);
  return resolved;
}

function hexNumber(value) {
  invariant(typeof value === 'string' && /^0x[0-9a-f]{1,8}$/iu.test(value), `expected 32-bit hex string, got ${JSON.stringify(value)}`);
  return Number.parseInt(value.slice(2), 16) >>> 0;
}

function hex32(value) {
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

function equalJson(actual, expected, message) {
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${message}\nexpected ${JSON.stringify(expected)}\nactual   ${JSON.stringify(actual)}`);
}

function validateArtifact(entry, artifact) {
  invariant(artifact?.schemaRevision === 1, `${entry.file}: unsupported schemaRevision`);
  invariant(artifact.id === entry.id, `${entry.file}: id does not match manifest`);
  invariant(artifact.profile === 'P7', `${entry.file}: decision vector must use P7 profile`);
  invariant(artifact.approvedBy === phase0ApprovalReviewer && artifact.approvedAt === '2026-08-26', `${entry.file}: missing product-owner approval provenance`);
}

export function evaluateExceptionCase(policy, input) {
  const stageOrder = new Map(policy.sameVictimStageOrder.map((stage, index) => [stage, index]));
  invariant(input.victims.length > 0, 'exception vector must have at least one victim');
  const victims = [...input.victims].sort((left, right) => left.age - right.age);
  const victim = victims[0];
  invariant(victim.exceptions.length > 0, 'exception victim must carry at least one exception');
  const selected = [...victim.exceptions].sort((left, right) => {
    invariant(stageOrder.has(left.stage) && stageOrder.has(right.stage), 'unknown exception stage');
    return stageOrder.get(left.stage) - stageOrder.get(right.stage);
  })[0];
  if (input.enabledInterrupt) {
    return { winner: 'interrupt', code: 0, victimAge: victim.age, stage: 'commit', retryCode: selected.code };
  }
  return { winner: 'exception', code: selected.code, victimAge: victim.age, stage: selected.stage, retryCode: null };
}

function runExceptionArtifact(artifact) {
  invariant(JSON.stringify(artifact.policy.sameVictimStageOrder) === JSON.stringify(['F', 'D', 'E', 'M']), 'exception policy must freeze F>D>E>M');
  const classifications = new Map(artifact.reachability.map((item) => [item.combination, item.classification]));
  invariant(classifications.get('RI + Syscall on one instruction') === 'unreachable', 'RI×Syscall must not be required as a Cartesian vector');
  invariant(classifications.get('Ov + load/store AdEL/AdES on one instruction') === 'unreachable', 'Ov×memory must not be required as a Cartesian vector');
  for (const vector of artifact.vectors) equalJson(evaluateExceptionCase(artifact.policy, vector.input), vector.expected, `${artifact.id}/${vector.id}`);
  return { id: artifact.id, status: 'passed', evidence: 'independent directed policy evaluator', vectors: artifact.vectors.length };
}

export function evaluateCp0Case(input) {
  const before = {
    sr: hexNumber(input.state.sr),
    cause: hexNumber(input.state.cause),
    epc: hexNumber(input.state.epc)
  };
  const actionKind = input.action.kind;
  if (input.reset === true) {
    return {
      state: { sr: hex32(0), cause: hex32(0), epc: hex32(0) },
      accepted: 'reset',
      actionSuppressed: actionKind !== 'none',
      nextPc: null,
      suppressSequentialSuccessor: false
    };
  }

  const hwInt = hexNumber(input.hwInt);
  const interruptEnabled = (before.sr & 1) !== 0
    && (before.sr & 2) === 0
    && ((((before.sr >>> 10) & 0x3f) & hwInt) !== 0);
  const accepted = interruptEnabled ? 'interrupt' : input.exceptionCode !== 0 ? 'exception' : 'none';
  let sr = before.sr;
  let cause = ((before.cause & ~0xfc00) | ((hwInt & 0x3f) << 10)) >>> 0;
  let epc = before.epc;
  let nextPc = null;
  let suppressSequentialSuccessor = false;
  let actionSuppressed = false;

  if (accepted !== 'none') {
    sr = (sr | 2) >>> 0;
    cause = (((input.inDelaySlot ? 1 : 0) << 31)
      | ((hwInt & 0x3f) << 10)
      | ((accepted === 'interrupt' ? 0 : input.exceptionCode) << 2)) >>> 0;
    epc = (hexNumber(input.victimPc) - (input.inDelaySlot ? 4 : 0)) >>> 0;
    actionSuppressed = actionKind !== 'none';
  } else if (actionKind === 'mtc0-sr') {
    sr = hexNumber(input.action.value);
  } else if (actionKind === 'mtc0-epc') {
    epc = hexNumber(input.action.value);
  } else if (actionKind === 'eret') {
    sr = (sr & ~2) >>> 0;
    nextPc = hex32(epc);
    suppressSequentialSuccessor = true;
  } else {
    invariant(actionKind === 'none', `unknown CP0 action ${actionKind}`);
  }

  return {
    state: { sr: hex32(sr), cause: hex32(cause), epc: hex32(epc) },
    accepted,
    actionSuppressed,
    nextPc,
    suppressSequentialSuccessor
  };
}

function runCp0Artifact(artifact) {
  equalJson(artifact.policy.updateOrder, ['reset', 'accepted-Req', 'victim-side-effect'], 'CP0 update order');
  const excluded = new Map(artifact.excludedCartesianCells.map((item) => [item.cell, item.classification]));
  invariant(excluded.get('eret in a branch delay slot') === 'undefined', 'eret delay-slot cell must be classified undefined');
  invariant(excluded.get('one instruction is both mtc0 and eret') === 'unreachable', 'mtc0×eret same-instruction cell must be unreachable');
  for (const vector of artifact.vectors) equalJson(evaluateCp0Case(vector.input), vector.expected, `${artifact.id}/${vector.id}`);
  return { id: artifact.id, status: 'passed', evidence: 'independent CP0 transition evaluator', vectors: artifact.vectors.length };
}

export function evaluateUnloadedCase(input) {
  const pc = hexNumber(input.pc);
  if ((pc & 3) !== 0 || pc < 0x3000 || pc > 0x6ffc) {
    return { status: 'exception', reason: 'invalid-fetch-address', instruction: null, synthetic: false, exception: 'AdEL' };
  }
  const key = hex32(pc);
  if (Object.hasOwn(input.image, key)) {
    return { status: 'execute', reason: 'loaded', instruction: hex32(hexNumber(input.image[key])), synthetic: false, exception: null };
  }
  if (input.mode === 'exploratory-zero-fill') {
    return { status: 'execute', reason: 'synthetic-zero-fill', instruction: hex32(0), synthetic: true, exception: null };
  }
  invariant(input.mode === 'strict', `unknown unloaded-IM mode ${input.mode}`);
  return { status: 'out-of-domain', reason: 'unloaded-instruction', instruction: null, synthetic: false, exception: null };
}

function runUnloadedArtifact(artifact) {
  invariant(artifact.policy.strict === 'out-of-domain', 'strict unloaded-IM policy must fail closed');
  invariant(artifact.policy.missingWordException === 'none', 'missing legal word must not be reported as AdEL');
  for (const vector of artifact.vectors) equalJson(evaluateUnloadedCase(vector.input), vector.expected, `${artifact.id}/${vector.id}`);
  return { id: artifact.id, status: 'passed', evidence: 'independent product-policy evaluator', vectors: artifact.vectors.length };
}

function normalizedLfSha256(file) {
  const normalized = fs.readFileSync(file, 'utf8').replace(/\r\n/gu, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function commandAvailable(command) {
  const result = spawnSync(command, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return result.error?.code !== 'ENOENT';
}

function parseTimerSnapshots(stdout) {
  const snapshots = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^SNAP\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/u.exec(line.trim());
    if (!match) continue;
    const [, label, state, ctrl, preset, count, latchedIrq, irq] = match;
    snapshots.push({ label, state: Number(state), ctrl: Number(ctrl), preset: Number(preset), count: Number(count), latchedIrq: Number(latchedIrq), irq: Number(irq) });
  }
  return snapshots;
}

function runTimerArtifact(artifact) {
  const rtl = containedFile(artifact.oracle.rtl);
  const testbench = containedFile(artifact.oracle.testbench);
  const actualHash = normalizedLfSha256(rtl);
  invariant(actualHash === artifact.oracle.rtlNormalizedLfSha256, `official Timer RTL hash mismatch: expected ${artifact.oracle.rtlNormalizedLfSha256}, got ${actualHash}`);

  const missing = ['iverilog', 'vvp'].filter((command) => !commandAvailable(command));
  if (missing.length > 0) {
    return { id: artifact.id, status: 'unavailable', evidence: `missing local tool(s): ${missing.join(', ')}`, vectors: artifact.snapshots.length };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'buaa-co-timer-vector-'));
  const simulation = path.join(temporaryDirectory, process.platform === 'win32' ? 'timer-vector.vvp' : 'timer-vector');
  try {
    const compile = spawnSync('iverilog', ['-g2012', '-s', 'decision_timer_restart_tb', '-o', simulation, rtl, testbench], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000
    });
    invariant(!compile.error && compile.status === 0, `iverilog failed (${compile.status}): ${(compile.stderr || compile.stdout).trim()}`);
    const execute = spawnSync('vvp', [simulation], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    invariant(!execute.error && execute.status === 0, `vvp failed (${execute.status}): ${(execute.stderr || execute.stdout).trim()}`);
    equalJson(parseTimerSnapshots(execute.stdout), artifact.snapshots, `${artifact.id}/official-RTL snapshots`);
    return { id: artifact.id, status: 'passed', evidence: `official RTL via Icarus; sha256-lf ${actualHash}`, vectors: artifact.snapshots.length };
  } finally {
    const expectedParent = path.resolve(os.tmpdir());
    if (path.dirname(path.resolve(temporaryDirectory)) === expectedParent && path.basename(temporaryDirectory).startsWith('buaa-co-timer-vector-')) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

export function loadDecisionArtifacts() {
  const manifest = readJson('manifest.json');
  invariant(manifest.schemaRevision === 1 && manifest.runnerRevision === 1, 'unsupported decision-vector manifest revision');
  const ids = new Set(manifest.vectors.map((entry) => entry.id));
  equalJson([...ids].sort(), [...expectedDecisionIds].sort(), 'decision-vector manifest IDs');
  return { manifest, entries: manifest.vectors.map((entry) => {
    invariant(/^[0-9a-f]{64}$/u.test(entry.normalizedLfSha256), `${entry.file}: missing normalized-LF artifact fingerprint`);
    const artifactFile = containedFile(entry.file);
    const actualHash = normalizedLfSha256(artifactFile);
    invariant(actualHash === entry.normalizedLfSha256, `${entry.file}: approved artifact hash mismatch; expected ${entry.normalizedLfSha256}, got ${actualHash}`);
    const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
    validateArtifact(entry, artifact);
    return { entry, artifact };
  }) };
}

export function runDecisionVectors({ requireRtl = false } = {}) {
  const { entries } = loadDecisionArtifacts();
  const results = [];
  for (const { entry, artifact } of entries) {
    try {
      let result;
      if (entry.kind === 'exception-priority') result = runExceptionArtifact(artifact);
      else if (entry.kind === 'cp0-same-cycle') result = runCp0Artifact(artifact);
      else if (entry.kind === 'official-timer-rtl') result = runTimerArtifact(artifact);
      else if (entry.kind === 'unloaded-im-policy') result = runUnloadedArtifact(artifact);
      else throw new Error(`unknown decision-vector kind ${entry.kind}`);
      results.push(result);
    } catch (error) {
      results.push({ id: entry.id, status: 'failed', evidence: error.message, vectors: 0 });
    }
  }
  const failed = results.filter((result) => result.status === 'failed');
  const unavailableRequired = requireRtl ? results.filter((result) => result.status === 'unavailable') : [];
  return { ok: failed.length === 0 && unavailableRequired.length === 0, requireRtl, results };
}
