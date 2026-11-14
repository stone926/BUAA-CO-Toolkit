// @index mips-host — Public lazy capture, inspection and immutable script-bound runtime adapter
import type { CustomInstructionMetadata, CustomInstructionMode } from '../core/custom/api';
import { MipsRuntimeManager, ScriptJobOptions } from './runtimeManager';
import { WorkerJob } from './workerProtocol';
import { ScriptInstructionBundle, validateScriptInstructionBundle } from './scriptInstructionBundle';
import * as path from 'path';
import * as fs from 'fs/promises';
export * from './scriptInstructionBundle';
const snapshotCache = new Map<string, ScriptInstructionBundle>();
const inspectionCache = new Map<string, readonly ScriptInstructionInspection[]>();

export type ScriptInstructionInspection = CustomInstructionMetadata & { readonly mask: number; readonly value: number; readonly template: string };
export interface ScriptRuntimeHost {
  runJob(job: WorkerJob, options?: ScriptJobOptions): ReturnType<MipsRuntimeManager['runJob']>;
  runScriptJob?(bundle: ScriptInstructionBundle, job: WorkerJob, options?: ScriptJobOptions): ReturnType<MipsRuntimeManager['runJob']>;
}

export async function captureScriptInstructions(workspaceRoot: string, options: ScriptJobOptions = {}): Promise<ScriptInstructionBundle | undefined> {
  const folder = path.join(workspaceRoot, '.co', 'custom-instructions');
  let entries: import('fs').Dirent[];
  try { entries = await fs.readdir(folder, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { snapshotCache.delete(path.resolve(workspaceRoot)); return undefined; } throw error; }
  if (!entries.some(entry => entry.isFile() && /\.(js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts'))) { snapshotCache.delete(path.resolve(workspaceRoot)); return undefined; }
  const runtime = new MipsRuntimeManager();
  const key = path.resolve(workspaceRoot);
  try {
    const result = await runtime.runIsolatedJob({ kind: 'script-capture', payload: { workspaceRoot: key, previous: snapshotCache.get(key) } }, options);
    if (result.kind !== 'result' || !result.ok) throw new Error(result.kind === 'result' ? result.error : 'Unexpected custom instruction capture response');
    if (result.payload === undefined) { snapshotCache.delete(key); return undefined; }
    const bundle = validateScriptInstructionBundle(result.payload);
    const cached = snapshotCache.get(key);
    if (cached?.digest === bundle.digest) return cached;
    snapshotCache.delete(key);
    snapshotCache.set(key, bundle);
    if (snapshotCache.size > 8) snapshotCache.delete(snapshotCache.keys().next().value!);
    return bundle;
  } finally { runtime.dispose(); }
}
export function createScriptRuntime(bundle: ScriptInstructionBundle, runtime?: ScriptRuntimeHost) {
  const frozen = validateScriptInstructionBundle(bundle);
  return { async runJob(job: WorkerJob, options: ScriptJobOptions = {}) {
    if (runtime?.runScriptJob) return runtime.runScriptJob(frozen, job, options);
    const dedicated = new MipsRuntimeManager();
    try { return await dedicated.runScriptJob(frozen, job, options); }
    finally { dedicated.dispose(); }
  } };
}
export async function inspectScriptInstructions(bundle: ScriptInstructionBundle, runtime?: ScriptRuntimeHost, mode?: CustomInstructionMode, options: ScriptJobOptions = {}): Promise<readonly ScriptInstructionInspection[]> {
  if (options.signal?.aborted) throw new Error('自定义指令加载已取消');
  validateScriptInstructionBundle(bundle);
  const cached = inspectionCache.get(bundle.digest);
  if (cached) return mode ? cached.filter(instruction => instruction.modes.includes(mode)) : cached;
  const result = await createScriptRuntime(bundle, runtime).runJob({ kind: 'script-inspect', payload: null }, options);
  if (result.kind !== 'result' || !result.ok) throw new Error(result.kind === 'result' ? result.error : 'Unexpected custom instruction inspection response');
  const metadata = freezeInspection((result.payload as { instructions: ScriptInstructionInspection[] }).instructions);
  inspectionCache.set(bundle.digest, metadata);
  if (inspectionCache.size > 32) inspectionCache.delete(inspectionCache.keys().next().value!);
  return mode ? metadata.filter(instruction => instruction.modes.includes(mode)) : metadata;
}

function freezeInspection<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeInspection(item);
    Object.freeze(value);
  }
  return value;
}
