import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHazardCaseInput } from '../hazardUi/caseInput';
import { analyzeHazardProgram } from '../hazardAnalysis/analyzer';
import { sha256Bytes } from '../asmCaseStoreCore';
import { manifestRunConfigurationHash, type AsmCaseManifestV2 } from '../courseTesting/manifestCodec';
import { captureSourceGraph } from '../mips/replay/sourceBundle';
import { serializeProgramImage } from '../mips/replay/programImage';
import { assembleCourseSource } from '../mips/core/assembler/assembler';
import { courseInstructionImageHexText } from '../mips/core/assembler/artifacts';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'co-hazard-context-')));
  roots.push(root);
  const caseDir = path.join(root, '.co', 'cases', 'saved-case');
  await fs.mkdir(caseDir, { recursive: true });
  const source = path.join(root, '中文 source.asm');
  const text = '.text 0x3000\nori $26,$0,0x1001\nmtc0 $26,$12\nori $1,$0,7\nori $2,$0,9\nhalt: beq $0,$0,halt\nnop\n.ktext 0x4180\nsw $0,0x7f20($0)\neret\nnop\n';
  await fs.writeFile(source, text);
  const captured = await captureSourceGraph(source, caseDir, undefined, undefined, { allowedRoot: root });
  const assembled = assembleCourseSource({ id: 'source-0000', text }, { profile: 'P7' });
  expect(assembled.ok).toBe(true);
  const image = assembled.image!;
  const write = async (relative: string, bytes: Buffer) => {
    await fs.mkdir(path.dirname(path.join(caseDir, relative)), { recursive: true });
    await fs.writeFile(path.join(caseDir, relative), bytes);
    return { path: relative, bytes: bytes.length, sha256: sha256Bytes(bytes) };
  };
  const engine = { id: 'builtin-ts', semanticsRevision: 1, capabilitiesRevision: 1 };
  const runConfiguration = {
    profile: 'P7', memoryConfiguration: 'CompactDataAtZero', interruptSchedule: [0x300c],
    deviceTimeline: { schemaRevision: 1 as const, events: [{ kind: 'external-interrupt' as const, trigger: 'macro-pc' as const, value: 0x300c }], probeMetadataDigest: null }
  };
  const code = await write('code.txt', Buffer.from(courseInstructionImageHexText(image)));
  const graphBytes = await fs.readFile(captured.graphPath);
  const manifest: AsmCaseManifestV2 = {
    version: 2, caseId: 'saved-case', createdAt: '2026-11-12T00:00:00Z', profile: 'P7',
    originalAsmPath: source, asmSnapshot: await write('program.asm', Buffer.from(text)), source: { kind: 'builtin' },
    p7: { interruptSchedule: [0x300c] },
    program: { assembler: engine, imageFingerprint: image.fingerprint,
      image: await write('program/image.json', serializeProgramImage(image)),
      sourceGraph: { path: 'source/graph.json', bytes: graphBytes.length, sha256: sha256Bytes(graphBytes) },
      machineCode: { ...code, wordCount: courseInstructionImageHexText(image).trim().split('\n').length }, dutInput: code },
    oracle: { engine, runConfiguration, configurationHash: manifestRunConfigurationHash(runConfiguration, engine), stopReason: 'unknown' }
  };
  const save = () => fs.writeFile(path.join(caseDir, 'case.json'), JSON.stringify(manifest));
  await save();
  return { root, caseDir, source, image, manifest, save, captured };
}

describe('saved case hazard execution context', () => {
  it('uses the verified image and original IRQ for root ASM, materialized root and complete HexText', async () => {
    const f = await fixture();
    for (const file of ['program.asm', f.captured.graph.units[0].materializedPath, 'code.txt']) {
      const loaded = await loadHazardCaseInput(path.join(f.caseDir, file), f.root, 'P7');
      expect(loaded).toMatchObject({ caseId: 'saved-case', externalInterrupts: [{ victimPc: 0x300c, occurrence: 1 }] });
      expect(loaded!.image.fingerprint).toBe(f.image.fingerprint);
      const report = await analyzeHazardProgram(loaded!.image, {
        profile: 'P7', externalInterrupts: loaded!.externalInterrupts, executionSource: 'case', caseId: loaded!.caseId,
        yieldControl: async () => undefined
      });
      expect(report.stopReason).toBe('course-halt-loop');
      expect(report.warnings.filter((warning) => warning.includes('发生中断'))).toHaveLength(1);
      expect(report.execution).toMatchObject({ source: 'case', caseId: 'saved-case', externalInterrupts: loaded!.externalInterrupts });
    }
  });

  it('does not scan or read unrelated adjacent manifests for standalone inputs', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'case.json'), '{bad');
    expect(await loadHazardCaseInput(f.source, f.root, 'P7')).toBeUndefined();
  });

  it.each(['program.asm', 'code.txt', 'source/graph.json', 'program/image.json'])(
    'rejects changed %s instead of inheriting an old schedule', async (file) => {
      const f = await fixture();
      await fs.chmod(path.join(f.caseDir, file), 0o644);
      await fs.appendFile(path.join(f.caseDir, file), ' ');
      await expect(loadHazardCaseInput(path.join(f.caseDir, file === 'code.txt' ? file : 'program.asm'), f.root, 'P7')).rejects.toThrow();
    }
  );

  it('rejects modified materialized includes/root even when the archived blobs are intact', async () => {
    const f = await fixture();
    await fs.chmod(f.captured.rootMaterializedPath, 0o644);
    await fs.appendFile(f.captured.rootMaterializedPath, 'nop\n');
    await expect(loadHazardCaseInput(path.join(f.caseDir, 'program.asm'), f.root, 'P7')).rejects.toThrow(/materialized/);
  });

  it.each(['profile', 'schedule', 'timeline', 'hash', 'probe', 'outside-text'])(
    'rejects inconsistent or unsupported %s context', async (kind) => {
      const f = await fixture();
      if (kind === 'profile') f.manifest.profile = 'P6';
      if (kind === 'schedule') f.manifest.p7!.interruptSchedule = [0x3008];
      if (kind === 'timeline') f.manifest.oracle.runConfiguration!.deviceTimeline!.events[0].value = 0x3008;
      if (kind === 'hash') f.manifest.oracle.configurationHash = '0'.repeat(64);
      if (kind === 'probe') f.manifest.p7!.probe = {};
      if (kind === 'outside-text') {
        f.manifest.p7!.interruptSchedule = [0x4184];
        delete f.manifest.oracle.runConfiguration;
      }
      await f.save();
      await expect(loadHazardCaseInput(path.join(f.caseDir, 'program.asm'), f.root, 'P7')).rejects.toThrow();
    }
  );

  it('rejects machine code that was rehashed but does not match the saved image', async () => {
    const f = await fixture();
    const bytes = Buffer.from('00000000\n');
    await fs.writeFile(path.join(f.caseDir, 'code.txt'), bytes);
    f.manifest.program.machineCode = { path: 'code.txt', bytes: bytes.length, sha256: sha256Bytes(bytes), wordCount: 1 };
    await f.save();
    await expect(loadHazardCaseInput(path.join(f.caseDir, 'code.txt'), f.root, 'P7')).rejects.toThrow(/机器码与用例程序映像不一致/);
  });

  it.each(['absent', 'initial'] as const)('analyzes a prepared case with %s oracle configuration and no old traces', async (kind) => {
    const f = await fixture();
    if (kind === 'absent') delete f.manifest.oracle.runConfiguration;
    else {
      const initial = { profile: 'P7', memoryConfiguration: 'CompactDataAtZero' };
      f.manifest.oracle.runConfiguration = initial;
      f.manifest.oracle.configurationHash = manifestRunConfigurationHash(initial, f.manifest.oracle.engine);
    }
    await f.save();
    expect((await loadHazardCaseInput(path.join(f.caseDir, 'program.asm'), f.root, 'P7'))!.externalInterrupts).toHaveLength(1);
  });
});
