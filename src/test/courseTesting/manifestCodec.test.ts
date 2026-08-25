import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AsmCaseManifestV2,
  asmCaseManifestVersion2,
  isKnownManifest,
  isManifestV2,
  manifestArtifactsOf,
  manifestMachineCodeOf,
  v2ArtifactGroup,
  v2ReplayClosureIssues,
  writeManifestAtomic
} from '../../courseTesting/manifestCodec';
import { AsmCaseManifest } from '../../asmCaseStoreCore';

const v1Manifest: AsmCaseManifest = {
  version: 1,
  caseId: 'case-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  profile: 'P4',
  originalAsmPath: 'E:/work/src/test.asm',
  asmSnapshot: { path: 'E:/work/.co/cases/case-1/program.asm', sha256: 'asm', bytes: 3 },
  source: { kind: 'selected' },
  machineCode: { path: 'E:/work/.co/cases/case-1/code.txt', sha256: 'code', bytes: 8, wordCount: 2, haltPc: 0x3004 },
  mars: { commandLine: 'java -jar Mars.jar', cwd: 'E:/work', memoryConfiguration: 'FixedCompactLargeText' },
  artifacts: {
    verilog: { traceOut: 'E:/work/.co/cases/case-1/verilog/sim.out' },
    mars: { traceOut: 'E:/work/.co/cases/case-1/mars/mars.out' },
    source: { original: 'E:/work/src/test.asm' }
  }
};

const v2Manifest: AsmCaseManifestV2 = {
  version: asmCaseManifestVersion2,
  caseId: 'case-2',
  createdAt: '2026-01-02T00:00:00.000Z',
  profile: 'P7',
  originalAsmPath: 'E:/work/src/test7.asm',
  asmSnapshot: { path: 'E:/work/.co/cases/case-2/program.asm', sha256: 'asm7', bytes: 3 },
  source: { kind: 'builtin' },
  program: {
    assembler: { id: 'legacy-mars-v0.6.3', semanticsRevision: 1, capabilitiesRevision: 1 },
    imageFingerprint: 'code7',
    machineCode: { path: 'code.txt', sha256: 'code7', bytes: 8, wordCount: 2, haltPc: 0x3004 }
  },
  oracle: {
    engine: { id: 'legacy-mars-v0.6.3', semanticsRevision: 1, capabilitiesRevision: 1 },
    configurationHash: 'cfg',
    stopReason: 'halt-loop'
  },
  artifacts: {
    oracle: { traceOut: 'oracle/mars.out' },
    dut: { 'verilog/traceOut': 'verilog/sim.out', 'logisim/preparedCircuit': 'logisim/cpu.circ' },
    source: { original: 'program.asm' }
  }
};

describe('manifest v1/v2 codec', () => {
  it('classifies v1 and v2 manifests and rejects unknown shapes', () => {
    expect(isKnownManifest(v1Manifest)).toBe(true);
    expect(isKnownManifest(v2Manifest)).toBe(true);
    expect(isKnownManifest(null)).toBe(false);
    expect(isKnownManifest({ version: 3, caseId: 'x' })).toBe(false);
    expect(isKnownManifest({ version: 1 })).toBe(false);
    expect(isKnownManifest({ version: 2, caseId: 'x', program: {}, oracle: {} })).toBe(true);
  });

  it('reads machine code from v1 top-level and v2 program section', () => {
    expect(manifestMachineCodeOf(v1Manifest)?.haltPc).toBe(0x3004);
    expect(manifestMachineCodeOf(v2Manifest)?.haltPc).toBe(0x3004);
    expect(manifestMachineCodeOf(v2Manifest)?.path).toBe('code.txt');
  });

  it('normalizes v1 artifacts unchanged', () => {
    const view = manifestArtifactsOf(v1Manifest);
    expect(view.verilog?.traceOut).toBe('E:/work/.co/cases/case-1/verilog/sim.out');
    expect(view.mars?.traceOut).toBe('E:/work/.co/cases/case-1/mars/mars.out');
    expect(view.source?.original).toBe('E:/work/src/test.asm');
  });

  it('maps v2 groups back to the v1-shaped view with dut prefixes', () => {
    const view = manifestArtifactsOf(v2Manifest);
    expect(view.mars?.traceOut).toBe('oracle/mars.out');
    expect(view.verilog?.traceOut).toBe('verilog/sim.out');
    expect(view.logisim?.preparedCircuit).toBe('logisim/cpu.circ');
    expect(view.source?.original).toBe('program.asm');
  });

  it('maps v1 artifact kinds to v2 groups and keys', () => {
    expect(v2ArtifactGroup('mars', 'traceOut')).toEqual({ group: 'oracle', key: 'traceOut' });
    expect(v2ArtifactGroup('verilog', 'traceOut')).toEqual({ group: 'dut', key: 'verilog/traceOut' });
    expect(v2ArtifactGroup('logisim', 'preparedCircuit')).toEqual({ group: 'dut', key: 'logisim/preparedCircuit' });
    expect(v2ArtifactGroup('source', 'original')).toEqual({ group: 'source', key: 'original' });
  });

  it('accepts a dumped v2 manifest as a phase-1 replay closure', () => {
    expect(v2ReplayClosureIssues(v2Manifest)).toEqual([]);
    const incomplete: AsmCaseManifestV2 = {
      ...v2Manifest,
      program: { ...v2Manifest.program, machineCode: undefined }
    };
    const issues = v2ReplayClosureIssues(incomplete);
    expect(issues).toContain('program.machineCode.sha256 missing (image not dumped yet)');
  });

  it('writes manifests atomically without leaving temp files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-'));
    try {
      const manifestPath = path.join(dir, 'case.json');
      await writeManifestAtomic(manifestPath, v2Manifest);
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AsmCaseManifestV2;
      expect(parsed.version).toBe(2);
      expect(parsed.program.machineCode?.path).toBe('code.txt');
      expect(isManifestV2(parsed)).toBe(true);
      const leftovers = fs.readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
