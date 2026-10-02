import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { loadCaseInspection, loadCaseWaveform, findSourceAtPc } from '../../courseTesting/caseInspection';
import { asmCaseManifestVersion2, type AsmCaseManifestV2 } from '../../courseTesting/manifestCodec';
import type { AsmCaseManifest } from '../../asmCaseStoreCore';
import { sha256Bytes } from '../../asmCaseStoreCore';
import { captureSourceGraph } from '../../mips/replay/sourceBundle';
import { serializeProgramImage } from '../../mips/replay/programImage';
import { buildProgramImage } from '../../mips/core/programImage';

vi.mock('vscode', async () => {
  const { URI } = await import('vscode-uri');
  const pathModule = await import('path');
  return {
    Uri: Object.assign(URI, {
      joinPath: (base: { fsPath: string }, ...parts: string[]) => URI.file(pathModule.join(base.fsPath, ...parts))
    })
  };
});

const engine = { id: 'builtin-ts', semanticsRevision: 1, capabilitiesRevision: 1 };

describe('loadCaseInspection', () => {
  it('loads a verified image and resolves its PC to the case-local source line and traces', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-inspection-'));
    try {
      const cases = path.join(root, '.co', 'cases');
      const caseId = '20261002T000000000Z-12345678';
      const caseDir = path.join(cases, caseId);
      const sourceDir = path.join(root, 'source');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.mkdir(sourceDir, { recursive: true });
      const sourcePath = path.join(sourceDir, 'input.asm');
      const sourceText = '.include "part.asm"\n.text\nnop\n';
      const includeText = '.text\nincluded: add $t0, $zero, $zero\n';
      await fs.writeFile(sourcePath, sourceText);
      await fs.writeFile(path.join(sourceDir, 'part.asm'), includeText);
      const bundle = await captureSourceGraph(sourcePath, caseDir, undefined, undefined, { allowedRoot: sourceDir });
      const rootUnit = bundle.graph.units.find((unit) => unit.id === bundle.graph.rootId)!;
      const asmBytes = Buffer.from(sourceText, 'utf8');
      const traceBytes = Buffer.from('@00003000: $8 <= 00000000\n', 'utf8');
      const dutBytes = Buffer.from('@00003000: $8 <= 00000001\n', 'utf8');
      await fs.writeFile(path.join(caseDir, 'program.asm'), asmBytes);
      await fs.writeFile(path.join(caseDir, 'code.txt'), '00000020\n');
      await fs.writeFile(path.join(caseDir, 'oracle.trace'), traceBytes);
      await fs.mkdir(path.join(caseDir, 'verilog'), { recursive: true });
      await fs.writeFile(path.join(caseDir, 'verilog', 'sim.out'), dutBytes);
      await fs.mkdir(path.join(caseDir, 'program'), { recursive: true });

      const image = buildProgramImage({
        entryPc: 0x3000,
        segments: [{ name: 'text', baseAddress: 0x3000, words: [0x20] }],
        sourceMap: [{
          segmentIndex: 0,
          wordIndex: 0,
          sourceId: bundle.graph.units.find((unit) => unit.id !== rootUnit.id)!.id,
          startOffset: includeText.indexOf('included:')
        }],
        inputGraph: bundle.graph.units.map((unit) => ({ id: unit.id, contentHash: unit.contentHash }))
      });
      const imageBytes = serializeProgramImage(image);
      await fs.writeFile(path.join(caseDir, 'program', 'image.json'), imageBytes);
      const graphBytes = await fs.readFile(bundle.graphPath);
      const compileLog = Buffer.from('compile failed: unknown port\n', 'utf8');
      await fs.writeFile(path.join(caseDir, 'verilog', 'compile.log'), compileLog);
      const snapshot = (filePath: string, bytes: Buffer) => ({ path: filePath, sha256: sha256Bytes(bytes), bytes: bytes.byteLength });
      let manifest: AsmCaseManifestV2 = {
        version: asmCaseManifestVersion2,
        caseId,
        createdAt: '2026-10-02T00:00:00.000Z',
        profile: 'P5',
        originalAsmPath: 'C:/private/user.asm',
        asmSnapshot: snapshot('program.asm', asmBytes),
        source: { kind: 'builtin' },
        program: {
          assembler: engine,
          imageFingerprint: image.fingerprint,
          image: snapshot('program/image.json', imageBytes),
          sourceGraph: snapshot('source/graph.json', graphBytes),
          machineCode: { ...snapshot('code.txt', Buffer.from('00000020\n')), wordCount: 1 }
        },
        oracle: { engine, configurationHash: 'a'.repeat(64), stopReason: 'unknown' },
        artifacts: {
          oracle: { traceOut: snapshot('oracle.trace', traceBytes) },
          dut: {
            'verilog/simOut': snapshot('verilog/sim.out', dutBytes),
            'verilog/compileLog': snapshot('verilog/compile.log', compileLog)
          }
        }
      };
      await fs.writeFile(path.join(caseDir, 'case.json'), JSON.stringify(manifest));

      const inspection = await loadCaseInspection(cases, caseId);
      expect(inspection.sourceAvailable).toBe(true);
      expect(inspection.oracle?.uri.fsPath.toLowerCase()).toBe(path.join(caseDir, 'oracle.trace').toLowerCase());
      expect(inspection.dut?.uri.fsPath.toLowerCase()).toBe(path.join(caseDir, 'verilog', 'sim.out').toLowerCase());
      expect(inspection.logs).toMatchObject([{ label: 'Icarus 编译日志' }]);
      expect(inspection.oracle).not.toHaveProperty('text');
      expect(inspection.logs[0]).not.toHaveProperty('text');
      const location = findSourceAtPc(inspection, 0x3000);
      const includedUnit = bundle.graph.units.find((unit) => unit.id !== rootUnit.id)!;
      expect(location).toMatchObject({ pc: 0x3000, line: 2, text: 'included: add $t0, $zero, $zero' });
      expect(location?.uri.fsPath.toLowerCase()).toBe(path.join(caseDir, includedUnit.materializedPath.replace(/\//g, path.sep)).toLowerCase());
      expect(location?.uri.fsPath).not.toContain('private');
      expect(findSourceAtPc(inspection, 0x3004)).toBeUndefined();

      const waveBytes = Buffer.from('$timescale 1ps $end\n');
      await fs.writeFile(path.join(caseDir, 'verilog', 'saved.vcd'), waveBytes);
      manifest.artifacts!.dut!['verilog/waveform'] = snapshot('verilog/saved.vcd', waveBytes);
      await fs.writeFile(path.join(caseDir, 'case.json'), JSON.stringify(manifest));
      const withWaveform = await loadCaseInspection(cases, caseId);
      expect((await loadCaseWaveform(withWaveform))?.fsPath.toLowerCase()).toBe(path.join(caseDir, 'verilog', 'saved.vcd').toLowerCase());
      await fs.writeFile(path.join(caseDir, 'verilog', 'saved.vcd'), Buffer.alloc(waveBytes.length, 32));
      await expect(loadCaseWaveform(withWaveform)).rejects.toThrow('hash');

      await fs.writeFile(path.join(caseDir, 'oracle.trace'), 'tampered trace\n');
      const damagedArtifact = await loadCaseInspection(cases, caseId);
      expect(damagedArtifact.oracle).toBeUndefined();
      expect(damagedArtifact.warnings.join('\n')).toContain('size mismatch');

      const mismatchedImage = buildProgramImage({
        entryPc: image.entryPc,
        segments: image.segments,
        sourceMap: image.sourceMap,
        inputGraph: image.inputGraph.map((unit, index) => index === 0 ? { ...unit, contentHash: 'f'.repeat(64) } : unit)
      });
      const mismatchedImageBytes = serializeProgramImage(mismatchedImage);
      await fs.writeFile(path.join(caseDir, 'program', 'image.json'), mismatchedImageBytes);
      manifest = {
        ...manifest,
        program: {
          ...manifest.program,
          imageFingerprint: mismatchedImage.fingerprint,
          image: snapshot('program/image.json', mismatchedImageBytes)
        }
      };
      await fs.writeFile(path.join(caseDir, 'case.json'), JSON.stringify(manifest));
      const mismatchedInspection = await loadCaseInspection(cases, caseId);
      expect(mismatchedInspection.sourceAvailable).toBe(true);
      expect(findSourceAtPc(mismatchedInspection, 0x3000)).toBeUndefined();
      expect(mismatchedInspection.warnings.join('\n')).toContain('源码图不匹配');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a case ID that could leave the cases directory', async () => {
    await expect(loadCaseInspection(os.tmpdir(), '../escape')).rejects.toThrow('Invalid ASM case ID');
  });

  it('keeps legacy ASM and artifact paths inside the case directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'co-inspection-legacy-'));
    try {
      const cases = path.join(root, '.co', 'cases');
      const caseId = 'legacy-case';
      const caseDir = path.join(cases, caseId);
      const outside = path.join(root, 'outside.asm');
      await fs.mkdir(caseDir, { recursive: true });
      await fs.writeFile(path.join(caseDir, 'program.asm'), '.text\nnop\n');
      await fs.writeFile(outside, 'secret source');
      const manifest: AsmCaseManifest = {
        version: 1,
        caseId,
        createdAt: '2026-10-02T00:00:00.000Z',
        profile: 'P5',
        originalAsmPath: outside,
        asmSnapshot: { path: outside, sha256: 'a'.repeat(64), bytes: 12 },
        source: { kind: 'builtin' },
        artifacts: { oracle: { traceOut: outside } }
      };
      await fs.writeFile(path.join(caseDir, 'case.json'), JSON.stringify(manifest));

      const inspection = await loadCaseInspection(cases, caseId);
      expect(inspection.sourceAvailable).toBe(true);
      expect(inspection.asmCase.asm.fsPath.toLowerCase()).toBe(path.join(caseDir, 'program.asm').toLowerCase());
      expect(inspection.oracle).toBeUndefined();
      expect(inspection.warnings.join('\n')).toContain('不在 case 目录内');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
