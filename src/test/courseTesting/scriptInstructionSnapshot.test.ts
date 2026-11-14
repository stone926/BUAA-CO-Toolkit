import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { captureCaseScriptInstructions, loadCaseScriptInstructions } from '../../courseTesting/scriptInstructionSnapshot';
import type { AsmCaseManifestV2 } from '../../courseTesting/manifestCodec';
import { scriptInstructionArtifact } from '../../mips/replay/scriptInstructionArtifact';
import { scriptInstructionBundleDigest, scriptInstructionHash, validateScriptInstructionBundle, type ScriptInstructionBundle } from '../../mips/host/scriptInstructionBundle';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('co-script-snapshot-')) await fs.rm(root, { recursive: true, force: true }); });
function bundle(): ScriptInstructionBundle {
  const source = 'export default []';
  const content = { version: 1 as const, runtimeVersion: 'co-script-runtime-v1' as const, sdkVersion: 'co-instruction-sdk-v1' as const,
    nodeVersion: process.versions.node, entries: ['指令.js'], files: [{ path: '指令.js', source, javascript: source, digest: scriptInstructionHash(JSON.stringify([source, source])) }] };
  return validateScriptInstructionBundle({ ...content, digest: scriptInstructionBundleDigest(content) });
}
const manifest = () => ({ version: 2, artifacts: { source: {} } } as AsmCaseManifestV2);

describe('immutable script ISA case snapshots', () => {
  it('authenticates canonical artifact bytes independent of JSON object key order', () => {
    const original = bundle();
    const artifact = scriptInstructionArtifact(original);
    expect(validateScriptInstructionBundle(JSON.parse(artifact.bytes.toString('utf8')))).toEqual(original);
  });
  it('retains the original JS closure after workspace edits and rejects changed saved bytes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-script-snapshot-')); roots.push(root);
    const original = bundle();
    const saved = await captureCaseScriptInstructions(root, manifest(), root, original);
    await fs.mkdir(path.join(root, '.co', 'custom-instructions'), { recursive: true });
    await fs.writeFile(path.join(root, '.co', 'custom-instructions', '指令.js'), 'throw new Error("changed")');
    expect(await loadCaseScriptInstructions(root, saved)).toEqual(original);
    await fs.appendFile(path.join(root, 'source', 'custom-instructions.json'), ' ');
    await expect(loadCaseScriptInstructions(root, saved)).rejects.toThrow();
  });
  it('records an empty registry without discovering newly added scripts during replay', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-script-snapshot-')); roots.push(root);
    const saved = await captureCaseScriptInstructions(root, manifest(), root, null);
    expect(await loadCaseScriptInstructions(root, saved)).toBeNull();
    expect(await loadCaseScriptInstructions(root, manifest())).toBeNull();
  });
  it('rejects a missing or replaced closure against recorded reference dependencies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-script-snapshot-')); roots.push(root);
    const original = bundle();
    const saved = await captureCaseScriptInstructions(root, manifest(), root, original);
    saved.program = { assembler: { id: 'builtin-ts', semanticsRevision: 1, capabilitiesRevision: 1,
      artifact: { sha256: '0'.repeat(64), dependencies: [{ ...scriptInstructionArtifact(original).identity, sha256: 'f'.repeat(64) }] } } };
    await expect(loadCaseScriptInstructions(root, saved)).rejects.toThrow(/引擎指纹/);
    delete saved.artifacts!.source!.customInstructions;
    delete saved.metadata!['customInstructions.digest'];
    await expect(loadCaseScriptInstructions(root, saved)).rejects.toThrow(/引擎指纹/);
  });
});
