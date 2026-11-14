// @index mips-host — Worker-local ESM evaluation, registry construction and custom job dispatch
import * as vm from 'vm';
import { CustomInstructionRegistry, validateScriptInstructionDefinitions } from '../core/custom/registry';
import { validateScriptInstructionBundle, scriptInstructionSdkModule } from './scriptInstructionBundle';
import { requireScriptRuntime, resolveScriptImport } from './scriptInstructionsCapture';
import type { WorkerJobExecutionContext } from './workerJobs';
import { executeProductionWorkerJob } from './workerJobs';
import { executeScriptGenerationJob } from './scriptGenerationJob';
import * as bits from '../core/custom/bits';
import { guardScriptInstructionDefinition } from './scriptInstructionDeterminism';

export async function executeScriptInstructionJob(payload: unknown, context: WorkerJobExecutionContext): Promise<unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid script job envelope');
  const request = payload as Record<string, unknown>;
  if (Object.keys(request).some(key => !['bundle', 'job'].includes(key)) || !request.job || typeof request.job !== 'object' || Array.isArray(request.job)) throw new Error('Invalid script job envelope');
  const job = request.job as Record<string, unknown>;
  if (Object.keys(job).some(key => !['kind', 'payload'].includes(key)) || typeof job.kind !== 'string'
    || ['script-job', 'script-capture'].includes(job.kind)) throw new Error('Invalid nested script job');
  const bundle = validateScriptInstructionBundle(request.bundle);
  requireScriptRuntime();
  // This is trusted workspace code, isolated for cancellation and reliability;
  // the VM context is not a security boundary for hostile code.
  const realm = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(`globalThis.Date = undefined; globalThis.WebAssembly = undefined;
    Object.defineProperty(Math, 'random', { value() { throw new Error('Custom instructions must be deterministic; Math.random is unavailable'); } });
    Object.freeze(Math);`, realm);
  const defineInstruction = vm.runInContext('(definition) => definition', realm) as (value: unknown) => unknown;
  const sdkExports = { defineInstruction, ...bits, bits: Object.freeze({ ...bits }) };
  for (const [name, value] of Object.entries(sdkExports)) Object.defineProperty(realm, name, { value, writable: false, configurable: false });
  const sdk = new vm.SyntheticModule(Object.keys(sdkExports), function () {
    for (const [name, value] of Object.entries(sdkExports)) this.setExport(name, value);
  }, { context: realm, identifier: scriptInstructionSdkModule });
  const modules = new Map<string, vm.SourceTextModule>();
  for (const file of bundle.files) modules.set(file.path, new vm.SourceTextModule(file.javascript, {
    context: realm, identifier: file.path,
    importModuleDynamically: () => { throw new Error('Dynamic imports are not supported in custom instructions; use captured static relative imports'); }
  }));
  const link = async (specifier: string, referencing: vm.Module): Promise<vm.Module> => {
    if (specifier === scriptInstructionSdkModule) return sdk;
    const target = modules.get(resolveScriptImport(referencing.identifier, specifier));
    if (!target) throw new Error(`Custom instruction snapshot lacks import: ${specifier}`);
    return target;
  };
  const definitions: unknown[] = [];
  for (const entry of bundle.entries) {
    const module = modules.get(entry)!;
    if (module.status === 'unlinked') await module.link(link);
    if (module.status === 'linked') await module.evaluate({ timeout: 1000 });
    const exported = (module.namespace as { default?: unknown }).default;
    if (exported === undefined) throw new Error(`${entry}: custom instruction entry must have a default export (definition or definition array); put helper modules in a subdirectory`);
    definitions.push(...(Array.isArray(exported) ? exported : [exported]));
  }
  const registry = new CustomInstructionRegistry(validateScriptInstructionDefinitions(definitions).map(guardScriptInstructionDefinition));
  if (job.kind === 'script-inspect') {
    return { bundleDigest: bundle.digest, instructions: registry.metadata().map(metadata => ({
      ...metadata, ...registry.encodings(metadata.modes[0]).find(encoding => encoding.mnemonic === metadata.mnemonic)!
    })) };
  }
  if (job.kind === 'script-generate') return executeScriptGenerationJob(job.payload, registry);
  return executeProductionWorkerJob(job.kind, job.payload, context, registry);
}
