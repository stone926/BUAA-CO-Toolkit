#!/usr/bin/env node
// End-to-end verification of the compiled worker, streamed batches and cooperative cancellation.
import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPath = path.join(root, 'out', 'mips', 'host', 'workerMain.js');
const protocolVersion = 2;
const sliceSize = 128;
const worker = new Worker(workerPath);
let sequence = 0;

function runJob(job, options = {}) {
  const requestId = `verify-${sequence++}`;
  const progress = [];
  let consumingProgress = false;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`worker request ${requestId} timed out`));
    }, 5000);
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`worker exited with code ${code} during ${requestId}`));
    };
    const onMessage = (message) => {
      if (!message || message.requestId !== requestId) {
        return;
      }
      if (message.kind === 'progress') {
        if (consumingProgress) {
          cleanup();
          reject(new Error(`worker emitted progress ${message.sequence} before the prior ACK`));
          return;
        }
        consumingProgress = true;
        progress.push(message.batch);
        Promise.resolve(options.onProgress?.(message.batch, requestId))
          .then(() => new Promise((done) => setTimeout(done, options.ackDelayMs ?? 0)))
          .then(() => {
            worker.postMessage({
              protocolVersion,
              kind: 'ack',
              requestId,
              sequence: message.sequence
            });
            consumingProgress = false;
          }, reject);
        return;
      }
      if (message.kind === 'result') {
        cleanup();
        resolve({ result: message, progress });
      }
    };
    function cleanup() {
      clearTimeout(timeout);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    }
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    worker.postMessage({
      protocolVersion,
      kind: 'request',
      requestId,
      jobId: `job-${requestId}`,
      job
    });
    if (options.cancelImmediately) {
      worker.postMessage({ protocolVersion, kind: 'cancel', requestId });
      worker.postMessage({ protocolVersion, kind: 'cancel', requestId });
    }
  });
}

try {
  const ping = await runJob({ kind: 'ping', payload: 'compiled-worker' });
  if (!ping.result.ok || ping.result.payload?.token !== 'compiled-worker') {
    throw new Error(`ping failed: ${JSON.stringify(ping)}`);
  }

  const words = new Array(sliceSize * 2 + 1).fill('0x00000000');
  const decode = await runJob({
    kind: 'isa-decode-batch',
    payload: { words, scope: { profile: 'P7', enabledLayers: ['required'] } }
  }, { ackDelayMs: 5 });
  if (!decode.result.ok
    || decode.result.payload?.processed !== words.length
    || decode.progress.map((batch) => batch.length).join(',') !== '128,128,1'
    || decode.progress.some((batch) => batch.some((entry) => entry.exactMnemonic !== 'nop'))) {
    throw new Error(`decode streaming failed: ${JSON.stringify(decode)}`);
  }

  const cancelled = await runJob({
    kind: 'isa-decode-batch',
    payload: {
      words: new Array(65_536).fill('0x00000000'),
      scope: { profile: 'P7', enabledLayers: ['required'] }
    }
  }, { cancelImmediately: true });
  const processedBeforeCancel = cancelled.progress.reduce((sum, batch) => sum + batch.length, 0);
  if (cancelled.result.ok
    || cancelled.result.cancelled !== true
    || processedBeforeCancel > sliceSize) {
    throw new Error(`cooperative cancellation exceeded one slice: ${JSON.stringify({
      result: cancelled.result,
      processedBeforeCancel
    })}`);
  }

  const afterCancel = await runJob({ kind: 'ping', payload: 'same-generation' });
  if (!afterCancel.result.ok || afterCancel.result.payload?.token !== 'same-generation') {
    throw new Error('worker did not remain usable after cooperative cancellation');
  }
  console.log('Compiled MIPS Worker verification passed (slice=128, ACK backpressure, repeated cancel idempotent).');
} finally {
  await worker.terminate();
}
