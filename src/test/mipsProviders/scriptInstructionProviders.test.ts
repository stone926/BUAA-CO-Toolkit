import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';
import { URI } from 'vscode-uri';
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  return { Uri: { file: URI.file }, workspace: { getWorkspaceFolder: () => ({ uri: URI.file(state.root) }) } };
});
vi.mock('../../config', () => ({ getProfile: () => 'P5', getMemoryConfiguration: () => 'CompactDataAtZero', useDelayedBranching: () => true }));
import { MipsRuntimeManager } from '../../mips/host/runtimeManager';
import { validateScriptInstructionBundle } from '../../mips/host/scriptInstructionBundle';
import { assembleWithPreflight, executeWithPreflight } from '../../mips/providers/providerResolver';
import { scriptInstructionArtifact } from '../../mips/replay/scriptInstructionArtifact';
import type { AppServices } from '../../types';

let root: string, worker: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-script-provider-'));
  worker = path.resolve('out', `script-provider-test-${process.pid}.cjs`);
  await build({ entryPoints: [path.resolve('src/mips/host/scriptInstructionWorker.ts')], outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterAll(async () => {
  await fs.rm(worker, { force: true });
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('co-script-provider-')) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(name: string, definition: string) {
  state.root = path.join(root, name);
  const directory = path.join(state.root, '.co', 'custom-instructions');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'instruction.js'), definition);
  const source = path.join(state.root, '程序.asm');
  await fs.writeFile(source, '.text\nxinc $1,$0,7\nsw $1,0($0)\nhalt: beq $0,$0,halt\nnop\n');
  const runtime = new MipsRuntimeManager({ scriptWorkerPath: worker });
  const captured = await runtime.runIsolatedJob({ kind: 'script-capture', payload: { workspaceRoot: state.root } });
  if (captured.kind !== 'result' || !captured.ok) throw new Error('capture failed');
  const original = validateScriptInstructionBundle(captured.payload);
  const bundle = validateScriptInstructionBundle(JSON.parse(scriptInstructionArtifact(original).bytes.toString('utf8')));
  return { runtime, bundle, source, services: { mipsRuntime: runtime } as AppServices };
}
const instruction = `import {defineInstruction,bits} from '@buaa-co/instructions';
export default defineInstruction({apiVersion:1,mnemonic:'xinc',modes:['P5'],encoding:'110011 rs:5 rt:5 immediate:16',
operands:[{kind:'register',field:'rt'},{kind:'register',field:'rs'},{kind:'immediate',field:'immediate'}],
execute(cpu,fields){return {gprWrites:[{register:fields.rt,value:bits.u32(cpu.readGpr(fields.rs)+fields.immediate)}]};}});`;

describe('production script-aware providers', () => {
  it('assembles a persisted script snapshot and binds the same definition to course trace execution', async () => {
    const fixtureCase = await fixture('roundtrip', instruction);
    const { runtime, services, bundle, source } = fixtureCase;
    try {
      const assembled = await assembleWithPreflight(services, { sourceUri: URI.file(source), scriptInstructions: bundle,
        target: { kind: 'userText', outputFile: URI.file(path.join(state.root, 'code.txt')) }, courseTrace: true, requirements: { profile: 'P5' } });
      expect(assembled.result?.ok, assembled.result?.status.stderr ?? JSON.stringify(assembled.preflight)).toBe(true);
      const result = assembled.result!;
      expect(result.customInstructionEncodings).toMatchObject([{ mnemonic: 'xinc', value: 0xcc000000 }]);
      expect(result.engineArtifact?.dependencies).toEqual([scriptInstructionArtifact(bundle).identity]);
      await fs.writeFile(path.join(state.root, '.co', 'custom-instructions', 'instruction.js'), 'throw new Error("later edit")');
      const executed = await executeWithPreflight(services, { image: result.image!, profile: 'P5', executionBinding: result.executionBinding,
        trace: { kind: 'architectural-writes', courseCorrect: true }, haltPc: result.courseHaltPc, maxSteps: 64 }, undefined, result.enginePlan);
      expect(executed.result?.ok, executed.result?.status.stderr).toBe(true);
      expect(executed.result?.trace?.rawText).toContain('00000007');
      expect(executed.result?.engineArtifact?.dependencies).toEqual(result.engineArtifact?.dependencies);
    } finally { runtime.dispose(); }
  });
  it('cancels a looping metadata getter during provider preflight', async () => {
    const { runtime, services, bundle, source } = await fixture('cancel', `export default {get apiVersion(){while(true){}},mnemonic:'bad'};`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 80), started = Date.now();
    try {
      const result = await assembleWithPreflight(services, { sourceUri: URI.file(source), scriptInstructions: bundle,
        target: { kind: 'userText' }, requirements: { profile: 'P5' } }, { signal: controller.signal });
      expect(result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(4000);
    } finally { clearTimeout(timer); runtime.dispose(); }
  });
});
