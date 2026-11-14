import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { MipsRuntimeManager } from '../../mips/host/runtimeManager';
import { createScriptRuntime, inspectScriptInstructions, captureScriptInstructions } from '../../mips/host/scriptInstructions';
import { ScriptInstructionBundle, validateScriptInstructionBundle } from '../../mips/host/scriptInstructionBundle';

let directory: string;
let workerPath: string;
beforeAll(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co-script-测试 '));
  workerPath = path.join(directory, 'worker.cjs');
  const built = await build({ entryPoints: [path.resolve('src/mips/host/scriptInstructionWorker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', write: false, define: { __dirname: JSON.stringify(path.resolve('out')) } });
  await fs.writeFile(workerPath, built.outputFiles![0].contents);
});
afterAll(async () => {
  if (directory && path.dirname(directory) === path.resolve(os.tmpdir()) && path.basename(directory).startsWith('co-script-测试 ')) await fs.rm(directory, { recursive: true, force: true });
});

function manager() { return new MipsRuntimeManager({ workerPath, scriptWorkerPath: workerPath }); }
async function sourceCase(name: string, files: Record<string, string>) {
  const root = path.join(directory, name);
  for (const [name, source] of Object.entries(files)) {
    const file = path.join(root, '.co', 'custom-instructions', name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source, 'utf8');
  }
  return root;
}
async function capture(runtime: MipsRuntimeManager, workspaceRoot: string, previous?: ScriptInstructionBundle) {
  const result = await runtime.runIsolatedJob({ kind: 'script-capture', payload: { workspaceRoot, previous } });
  if (result.kind !== 'result' || !result.ok) throw new Error(result.kind === 'result' ? result.error : 'Expected capture result');
  return validateScriptInstructionBundle(result.payload);
}
const descriptor = `{
  apiVersion: 1, mnemonic: 'addi_custom', modes: ['P6', 'mars'],
  encoding: '011111 rs:5 rt:5 immediate:16',
  operands: [{kind:'register',field:'rt'},{kind:'register',field:'rs'},{kind:'immediate',field:'immediate',signed:true}],
  access: {reads:['rs'],writes:['rt']},
  execute(ctx, fields) { return {gprWrites:[{register:fields.rt,value:ctx.readGpr(fields.rs)+signed(fields.immediate)}]}; }
}`;

describe('native JavaScript and TypeScript custom instruction workers', () => {
  it('avoids starting a worker for an ordinary workspace or ambient declarations', async () => {
    expect(await captureScriptInstructions(directory)).toBeUndefined();
    const root = await sourceCase('ambient', { 'sdk.d.ts': 'declare const x: number;' });
    expect(await captureScriptInstructions(root)).toBeUndefined();
  });

  it('captures Unicode relative imports and gives JS and erasable TS the same assembly and execution', async () => {
    const runtime = manager();
    try {
      const bundles: ScriptInstructionBundle[] = [];
      for (const extension of ['js', 'ts']) {
        const root = await sourceCase(extension, {
          [`main.${extension}`]: `import {defineInstruction} from '@buaa-co/instructions'; import {signed} from './帮助/helper.${extension}'; export default defineInstruction(${descriptor});`,
          [`帮助/helper.${extension}`]: `import {signExtend} from '@buaa-co/instructions'; export function signed(value${extension === 'ts' ? ': number' : ''})${extension === 'ts' ? ': number' : ''} { return signExtend(value,16); }`
        });
        const bundle = await capture(runtime, root);
        bundles.push(bundle);
        expect(bundle.files).toHaveLength(2);
        expect(Object.isFrozen(bundle.files[0])).toBe(true);
        expect(await inspectScriptInstructions(bundle, runtime, 'P6')).toMatchObject([{ mnemonic: 'addi_custom', mask: 0xfc000000, value: 0x7c000000 }]);
      }
      const results: unknown[] = [];
      for (const bundle of bundles) {
        const bound = createScriptRuntime(bundle, runtime);
        const assembly = await bound.runJob({ kind: 'assembler-assemble', payload: { profile:'P6',sources:[{id:'main',text:'addi_custom $t0, $zero, -7\nnop'}] } });
        expect(assembly).toMatchObject({ok:true,payload:{ok:true}});
        if (assembly.kind !== 'result') throw new Error('Expected assembly result');
        const image = (assembly.payload as {image:{entryPc:number;segments:{name:string;baseAddress:number;words:number[]}[]}}).image;
        results.push(image.segments[0].words);
        const execution = await bound.runJob({ kind:'machine-execute',payload:{profile:'P6',enabledLayers:['required'],
          entryPc:'0x00003000',haltPc:'0x00003004',maxSteps:2,collectTrace:true,
          segments:[{name:'text',baseAddress:'0x00003000',words:image.segments[0].words.map(word => `0x${word.toString(16).padStart(8,'0')}`)}]} });
        expect(execution).toMatchObject({ok:true,payload:{status:'step-limit',trace:expect.arrayContaining(['@00003000: $8 <= FFFFFFF9'])}});
      }
      expect(results[0]).toEqual(results[1]);
    } finally { runtime.dispose(); }
  });

  it('rejects syntax, package/Node imports, missing globals, and tampered frozen snapshots', async () => {
    const runtime = manager();
    try {
      for (const [name, code, message] of [
        ['syntax','export default {','SyntaxError'],
        ['node',"import fs from 'node:fs'; export default []",'must be relative'],
        ['package',"import x from 'some-package'; export default []",'must be relative']
      ]) {
        const root = await sourceCase(name, { 'main.js': code });
        await expect(capture(runtime, root)).rejects.toThrow(message);
      }
      const root = await sourceCase('globals', { 'main.js': 'export default process.cwd();' });
      const bundle = await capture(runtime, root);
      await expect(inspectScriptInstructions(bundle, runtime)).rejects.toThrow('process is not defined');
      const changed = JSON.parse(JSON.stringify(bundle));
      changed.files[0].javascript += '\nthrow new Error("tampered");';
      expect(() => validateScriptInstructionBundle(changed)).toThrow('source snapshot');
    } finally { runtime.dispose(); }
  });

  it('refreshes changed imports and preserves previous immutable source snapshots', async () => {
    const runtime = manager();
    try {
      const root = await sourceCase('cache', { 'main.ts':'import {value} from "./lib/value.ts"; export default value;', 'lib/value.ts':'export const value: unknown[] = [];' });
      const first = await capture(runtime, root);
      expect((await capture(runtime, root, first)).digest).toBe(first.digest);
      await fs.writeFile(path.join(root,'.co/custom-instructions/lib/value.ts'),'export const value: unknown[] = []; // edited');
      const changed = await capture(runtime, root, first);
      expect(changed.digest).not.toBe(first.digest);
      expect(first.files.find(file => file.path === 'lib/value.ts')!.source).not.toContain('edited');
    } finally { runtime.dispose(); }
  });

  it('rejects persistent JS closure state before a custom effect reaches the CPU', async () => {
    const runtime = manager();
    try {
      const stateful = descriptor.replace('ctx.readGpr(fields.rs)+signed(fields.immediate)', 'counter++');
      const root = await sourceCase('stateful-callback', { 'main.js': `let counter=0; export default ${stateful};` });
      const bundle = await capture(runtime, root);
      const result = await runtime.runScriptJob(bundle, { kind:'machine-execute',payload:{profile:'P6',enabledLayers:['required'],entryPc:'0x00003000',maxSteps:2,collectTrace:true,
        segments:[{name:'text',baseAddress:'0x00003000',words:['0x7c080001','0x00000000']}] } });
      expect(result).toMatchObject({ok:true,payload:{status:'out-of-domain',trace:[],diagnostic:{message:expect.stringContaining('execute 必须仅依赖context/fields且无持久可变状态')}}});
    } finally { runtime.dispose(); }
  });

  it('kills looping initialization and callbacks promptly without disrupting ordinary jobs', async () => {
    const runtime = manager();
    try {
      const root = await sourceCase('loop-init', { 'main.js':'while (true) {} export default [];' });
      const bundle = await capture(runtime, root);
      const inspection = await runtime.runScriptJob(bundle,{kind:'script-inspect',payload:null},{timeoutMs:350});
      expect(inspection).toMatchObject({ok:false,error:expect.stringContaining('limit')});
      const callbackRoot = await sourceCase('loop-callback', { 'main.js': `const signed = v => v; export default ${descriptor.replace('return {gprWrites:', 'while(true) {} return {gprWrites:')};` });
      const callbacks = await capture(runtime, callbackRoot);
      const abort = new AbortController();
      const start = Date.now();
      const running = runtime.runScriptJob(callbacks, {kind:'machine-execute',payload:{profile:'P6',enabledLayers:['required'],entryPc:'0x00003000',maxSteps:2,segments:[{name:'text',baseAddress:'0x00003000',words:['0x7c080001']}] }},{signal:abort.signal});
      setTimeout(() => abort.abort(),200);
      expect(await running).toMatchObject({ok:false,cancelled:true});
      expect(Date.now()-start).toBeLessThan(2000);
      expect(await runtime.runJob({kind:'ping',payload:'still responsive'})).toMatchObject({ok:true,payload:{token:'still responsive'}});
    } finally { runtime.dispose(); }
  });
});
