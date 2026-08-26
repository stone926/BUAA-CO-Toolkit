#!/usr/bin/env node
// Real-JVM evidence for the shared cross-platform process supervisor.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProcessCore } from '../out/processCore.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'test', 'fixtures', 'processTree', 'ProcessTreeHelper.java');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'co-java-tree-evidence-'));
const classes = path.join(temporaryRoot, 'classes');
fs.mkdirSync(classes);

const javac = process.env.JAVAC || 'javac';
const java = process.env.JAVA || 'java';
const compile = spawnSync(javac, ['-encoding', 'UTF-8', '-d', classes, source], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true
});
if (compile.error) {
  throw compile.error;
}
if (compile.status !== 0) {
  throw new Error(`javac failed (${compile.status}):\n${compile.stdout}\n${compile.stderr}`);
}

const javaVersionResult = spawnSync(java, ['-version'], { encoding: 'utf8', windowsHide: true });
const javaVersion = `${javaVersionResult.stderr || ''}\n${javaVersionResult.stdout || ''}`
  .split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'unknown';

const evidence = [];
try {
  evidence.push(await verifyAbort());
  evidence.push(await verifyTimeout());
  const report = {
    kind: 'shared-process-supervisor-real-jvm-evidence',
    schemaVersion: 1,
    scope: {
      proves: ['runProcessCore JVM descendant-tree termination', 'inherited-pipe close', 'single settlement'],
      requiresSeparateAdapterWiringTests: ['legacy Java/MARS', 'ISim', 'Logisim']
    },
    platform: process.platform,
    arch: process.arch,
    javaVersion,
    cases: evidence
  };
  const evidenceOutput = process.env.CO_PROCESS_EVIDENCE_OUTPUT;
  if (evidenceOutput) {
    const resolved = path.resolve(evidenceOutput);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

async function verifyAbort() {
  const pidFile = path.join(temporaryRoot, 'abort-grandchild.pid');
  const controller = new AbortController();
  let settlements = 0;
  const startedAt = Date.now();
  const pending = runProcessCore(java, ['-cp', classes, 'ProcessTreeHelper', 'parent', pidFile], {
    cwd: temporaryRoot,
    signal: controller.signal,
    cancelGraceMs: 300,
    timeoutMs: 10_000,
    onStdoutLine: (line) => {
      if (line === 'grandchild-ready') {
        controller.abort();
        controller.abort();
      }
    }
  });
  void pending.then(() => { settlements++; });
  const result = await pending;
  await delay(100);
  const grandchildPid = readPid(pidFile);
  if (!result.stopped || result.stopReason !== 'aborted' || result.ok || settlements !== 1) {
    throw new Error(`abort lifecycle failed: ${JSON.stringify({ result, settlements })}`);
  }
  if (!await waitForProcessExit(grandchildPid, 3000)) {
    forceCleanup(grandchildPid);
    throw new Error(`abort left JVM grandchild ${grandchildPid} alive`);
  }
  if (!result.stdout.includes('grandchild-ready')) {
    throw new Error('abort evidence did not capture the inherited grandchild stdout pipe');
  }
  return {
    fixture: 'real-java-parent-grandchild',
    trigger: 'abort',
    stopped: true,
    stopReason: result.stopReason,
    descendantExited: true,
    inheritedPipesClosedBeforeSettlement: true,
    settlements,
    repeatedCancelIdempotent: true,
    elapsedMs: Date.now() - startedAt
  };
}

async function verifyTimeout() {
  const pidFile = path.join(temporaryRoot, 'timeout-grandchild.pid');
  let timeoutCalls = 0;
  let settlements = 0;
  const startedAt = Date.now();
  const pending = runProcessCore(java, ['-cp', classes, 'ProcessTreeHelper', 'parent', pidFile], {
    cwd: temporaryRoot,
    timeoutMs: 500,
    cancelGraceMs: 300,
    onTimeout: () => { timeoutCalls++; }
  });
  void pending.then(() => { settlements++; });
  const result = await pending;
  await delay(100);
  const grandchildPid = readPid(pidFile);
  if (!result.timedOut || !result.stopped || result.stopReason !== 'timeout'
    || result.ok || timeoutCalls !== 1 || settlements !== 1) {
    throw new Error(`timeout lifecycle failed: ${JSON.stringify({ result, timeoutCalls, settlements })}`);
  }
  if (!await waitForProcessExit(grandchildPid, 3000)) {
    forceCleanup(grandchildPid);
    throw new Error(`timeout left JVM grandchild ${grandchildPid} alive`);
  }
  if (!result.stdout.includes('grandchild-ready')) {
    throw new Error('timeout evidence did not capture the inherited grandchild stdout pipe');
  }
  return {
    fixture: 'real-java-parent-grandchild',
    trigger: 'timeout',
    timedOut: true,
    descendantExited: true,
    inheritedPipesClosedBeforeSettlement: true,
    timeoutCallbacks: timeoutCalls,
    settlements,
    elapsedMs: Date.now() - startedAt
  };
}

function readPid(file) {
  const pid = Number(fs.readFileSync(file, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`invalid descendant pid in ${file}`);
  }
  return pid;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await delay(25);
  }
  return !isProcessAlive(pid);
}

function forceCleanup(pid) {
  if (!isProcessAlive(pid)) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
