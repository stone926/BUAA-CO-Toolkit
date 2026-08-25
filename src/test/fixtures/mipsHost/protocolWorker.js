// JS fixture worker implementing the phase-1 protocol skeleton, so host-side
// integration tests do not depend on the compiled out/ tree.
// job kinds: ping (echo token), crash (process.exit(1)).
'use strict';
const { parentPort } = require('worker_threads');

function respond(message) {
  parentPort.postMessage(message);
}

parentPort.on('message', (raw) => {
  if (!raw || raw.protocolVersion !== 1) {
    return;
  }
  if (raw.kind === 'cancel') {
    respond({ protocolVersion: 1, kind: 'result', requestId: raw.requestId, ok: false, error: 'cancelled' });
    return;
  }
  const payload = raw.job && raw.job.payload;
  if (raw.job && raw.job.kind === 'crash') {
    process.exit(1);
  }
  respond({
    protocolVersion: 1,
    kind: 'result',
    requestId: raw.requestId,
    ok: true,
    payload: { token: payload ?? null }
  });
});
