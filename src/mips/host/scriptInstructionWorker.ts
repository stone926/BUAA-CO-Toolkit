// @index mips-host — Dedicated bounded script worker entry, isolated from ordinary course and MARS jobs
import { registerWorkerJobHandler } from './workerMain';
import { executeScriptInstructionJob } from './scriptInstructionJobs';
import { captureScriptInstructionBundle } from './scriptInstructionsCapture';
import { validateScriptInstructionBundle } from './scriptInstructionBundle';

registerWorkerJobHandler('script-job', (request, signal, emitProgress) => executeScriptInstructionJob(request.job.payload, { signal, emitProgress }));
registerWorkerJobHandler('script-capture', request => {
  const payload = request.job.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid custom instruction capture request');
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).some(key => !['workspaceRoot', 'previous'].includes(key))
    || typeof value.workspaceRoot !== 'string' || !value.workspaceRoot || value.workspaceRoot.length > 32768) throw new Error('Invalid custom instruction workspace path');
  return captureScriptInstructionBundle(value.workspaceRoot, value.previous === undefined ? undefined : validateScriptInstructionBundle(value.previous));
});
