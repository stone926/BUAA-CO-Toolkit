#!/usr/bin/env node
// Portable end-to-end proof through the production RuntimeManager -> WorkerClient -> Worker path.
import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(root, 'out', 'mips', 'host', 'workerMain.js');
const managerPath = path.join(root, 'out', 'mips', 'host', 'runtimeManager.js');
const { MipsRuntimeManager } = createRequire(import.meta.url)(managerPath);
const sliceSize = 128;
const observations = [];
const manager = new MipsRuntimeManager({
  workerPath,
  cancelGraceMs: 1000,
  observeProtocol: (observation) => observations.push(observation)
});

function jobObservations(startIndex) {
  const slice = observations.slice(startIndex);
  const request = slice.find((item) => item.direction === 'out' && item.kind === 'request');
  if (!request) throw new Error(`job emitted no production request: ${JSON.stringify(slice)}`);
  return {
    requestId: request.requestId,
    events: slice.filter((item) => item.requestId === request.requestId)
  };
}

function sequences(events, direction, kind) {
  return events
    .filter((item) => item.direction === direction && item.kind === kind)
    .map((item) => item.sequence);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, label, milliseconds = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function writeEvidence(file, evidence) {
  const absolute = path.resolve(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, absolute);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

try {
  if (manager.started) throw new Error('RuntimeManager started a Worker before first use');

  const ping = await withTimeout(manager.runJob({ kind: 'ping', payload: 'compiled-worker' }), 'initial ping');
  if (!manager.started || !ping.ok || ping.payload?.token !== 'compiled-worker') {
    throw new Error(`production RuntimeManager ping failed: ${JSON.stringify(ping)}`);
  }

  const words = new Array(sliceSize * 2 + 1).fill('0x00000000');
  const decodeStart = observations.length;
  const batches = [];
  let releaseFirstBatch;
  let firstBatchStarted;
  const firstBatchGate = new Promise((resolve) => { releaseFirstBatch = resolve; });
  const firstBatchSignal = new Promise((resolve) => { firstBatchStarted = resolve; });
  let decodeSettled = false;
  const decodePromise = manager.runJob({
    kind: 'isa-decode-batch',
    payload: { words, scope: { profile: 'P7', enabledLayers: ['required'] } }
  }, {
    onProgress: async (batch) => {
      batches.push(batch);
      if (batches.length === 1) {
        firstBatchStarted();
        await firstBatchGate;
      }
    }
  }).then((result) => {
    decodeSettled = true;
    return result;
  });
  await withTimeout(firstBatchSignal, 'first progress batch');
  await delay(25);
  const blocked = jobObservations(decodeStart);
  if (decodeSettled
    || sequences(blocked.events, 'out', 'ack').length !== 0
    || blocked.events.some((item) => item.direction === 'in' && item.kind === 'result')) {
    throw new Error(`terminal/ACK escaped before the progress consumer completed: ${JSON.stringify(blocked.events)}`);
  }
  releaseFirstBatch();
  const decode = await withTimeout(decodePromise, 'streamed decode');
  const decoded = jobObservations(decodeStart);
  const progressSequences = sequences(decoded.events, 'in', 'progress');
  const ackSequences = sequences(decoded.events, 'out', 'ack');
  const lastAckIndex = decoded.events.findLastIndex((item) => item.direction === 'out' && item.kind === 'ack');
  const resultIndex = decoded.events.findIndex((item) => item.direction === 'in' && item.kind === 'result');
  if (!decode.ok
    || decode.payload?.processed !== words.length
    || batches.map((batch) => batch.length).join(',') !== '128,128,1'
    || batches.some((batch) => batch.some((entry) => entry.exactMnemonic !== 'nop'))
    || progressSequences.join(',') !== '0,1,2'
    || ackSequences.join(',') !== '0,1,2'
    || lastAckIndex < 0
    || resultIndex <= lastAckIndex) {
    throw new Error(`production streaming/sequence proof failed: ${JSON.stringify({
      decode,
      batchSizes: batches.map((batch) => batch.length),
      events: decoded.events
    })}`);
  }

  const failureStart = observations.length;
  const consumerFailure = await withTimeout(manager.runJob({
    kind: 'isa-decode-batch',
    payload: {
      words: new Array(sliceSize + 1).fill('0x00000000'),
      scope: { profile: 'P7', enabledLayers: ['required'] }
    }
  }, {
    onProgress: () => { throw new Error('intentional portable verifier failure'); }
  }), 'progress consumer failure');
  const failed = jobObservations(failureStart);
  if (consumerFailure.ok
    || !consumerFailure.error?.includes('progress consumer failed')
    || sequences(failed.events, 'in', 'progress').join(',') !== '0'
    || sequences(failed.events, 'out', 'ack').length !== 0
    || failed.events.filter((item) => item.direction === 'out' && item.kind === 'cancel').length !== 1) {
    throw new Error(`failed progress must not be ACKed: ${JSON.stringify({ consumerFailure, events: failed.events })}`);
  }

  const cancelStart = observations.length;
  const controller = new AbortController();
  let processedBeforeCancel = 0;
  const cancelled = await withTimeout(manager.runJob({
    kind: 'isa-decode-batch',
    payload: {
      words: new Array(65_536).fill('0x00000000'),
      scope: { profile: 'P7', enabledLayers: ['required'] }
    }
  }, {
    signal: controller.signal,
    onProgress: (batch) => {
      processedBeforeCancel += batch.length;
      controller.abort();
      controller.abort();
    }
  }), 'cooperative cancellation');
  const cancelledEvents = jobObservations(cancelStart);
  if (cancelled.ok
    || cancelled.cancelled !== true
    || processedBeforeCancel > sliceSize
    || cancelledEvents.events.filter((item) => item.direction === 'out' && item.kind === 'cancel').length !== 1
    || sequences(cancelledEvents.events, 'out', 'ack').length !== 0) {
    throw new Error(`cooperative cancellation exceeded one slice or was not idempotent: ${JSON.stringify({
      cancelled,
      processedBeforeCancel,
      events: cancelledEvents.events
    })}`);
  }

  const afterCancel = await withTimeout(manager.runJob({ kind: 'ping', payload: 'same-generation' }), 'post-cancel ping');
  if (!afterCancel.ok || afterCancel.payload?.token !== 'same-generation') {
    throw new Error('production Worker path did not remain usable after cancellation/failure');
  }
  const evidenceOutput = process.env.CO_MIPS_WORKER_EVIDENCE_OUTPUT;
  if (evidenceOutput) {
    const trackedStatus = git(['status', '--porcelain=v1', '--untracked-files=no']);
    if (trackedStatus) {
      throw new Error(`refusing Worker evidence for a dirty tracked tree:\n${trackedStatus}`);
    }
    writeEvidence(evidenceOutput, {
      schemaRevision: 1,
      kind: 'phase1-worker-portability-evidence',
      generatedAt: new Date().toISOString(),
      platform: { os: process.platform, arch: process.arch, node: process.version },
      source: {
        commit: git(['rev-parse', 'HEAD']),
        tree: git(['rev-parse', 'HEAD^{tree}']),
        verifierSha256: sha256File(fileURLToPath(import.meta.url)),
        runtimeManagerSha256: sha256File(path.join(root, 'src', 'mips', 'host', 'runtimeManager.ts')),
        workerClientSha256: sha256File(path.join(root, 'src', 'mips', 'host', 'workerClient.ts')),
        workerMainSha256: sha256File(path.join(root, 'src', 'mips', 'host', 'workerMain.ts')),
        compiledWorkerSha256: sha256File(workerPath)
      },
      assertions: {
        lazyStart: true,
        progressSequences,
        ackSequences,
        terminalAfterFinalAck: resultIndex > lastAckIndex,
        progressConsumerFailure: {
          progressSequences: sequences(failed.events, 'in', 'progress'),
          ackSequences: sequences(failed.events, 'out', 'ack'),
          cancelMessages: failed.events.filter((item) => item.direction === 'out' && item.kind === 'cancel').length
        },
        cooperativeCancellation: {
          processedBeforeCancel,
          sliceSize,
          cancelMessages: cancelledEvents.events.filter((item) => item.direction === 'out' && item.kind === 'cancel').length,
          ackSequences: sequences(cancelledEvents.events, 'out', 'ack')
        },
        postCancelGenerationUsable: true
      }
    });
  }
  console.log('Compiled MIPS Worker verification passed through RuntimeManager/WorkerClient (lazy start, sequence 0..2, ACK ordering, consumer failure, one-slice cancel).');
} finally {
  manager.dispose();
}
