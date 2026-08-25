import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  AsmCaseManifestV2,
  asmCaseManifestVersion2,
  isKnownManifest,
  isManifestV2,
  manifestArtifactsOf,
  manifestMachineCodeOf,
  manifestRunConfigurationHash,
  v2ArtifactGroup,
  v2ReplayBundleIssues,
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
  asmSnapshot: { path: 'E:/work/.co/cases/case-1/program.asm', sha256: 'a'.repeat(64), bytes: 3 },
  source: { kind: 'selected' },
  machineCode: { path: 'E:/work/.co/cases/case-1/code.txt', sha256: 'b'.repeat(64), bytes: 8, wordCount: 2, haltPc: 0x3004 },
  mars: { commandLine: 'java -jar Mars.jar', cwd: 'E:/work', memoryConfiguration: 'FixedCompactLargeText' },
  artifacts: {
    verilog: { traceOut: 'E:/work/.co/cases/case-1/verilog/sim.out' },
    mars: { traceOut: 'E:/work/.co/cases/case-1/mars/mars.out' },
    source: { original: 'E:/work/src/test.asm' }
  }
};

const testEngine = {
  id: 'legacy-mars-configured', semanticsRevision: 1, capabilitiesRevision: 1,
  artifact: { sha256: 'b'.repeat(64), role: 'user-configured-mars' }
};
const testRunConfiguration = {
  profile: 'P7',
  memoryConfiguration: 'CompactLargeText',
  courseTrace: true,
  haltPc: 0x3004
} as const;

function artifact(path: string, digest = 'd'): { path: string; sha256: string; bytes: number } {
  return { path, sha256: digest.repeat(64), bytes: 1 };
}

const v2Manifest: AsmCaseManifestV2 = {
  version: asmCaseManifestVersion2,
  caseId: 'case-2',
  createdAt: '2026-01-02T00:00:00.000Z',
  profile: 'P7',
  originalAsmPath: 'E:/work/src/test7.asm',
  asmSnapshot: { path: 'program.asm', sha256: 'a'.repeat(64), bytes: 3 },
  source: { kind: 'builtin' },
  program: {
    assembler: testEngine,
    imageFingerprint: 'c'.repeat(64),
    machineCode: { path: 'code.txt', sha256: 'c'.repeat(64), bytes: 8, wordCount: 2, haltPc: 0x3004 }
  },
  oracle: {
    engine: testEngine,
    configurationHash: manifestRunConfigurationHash(testRunConfiguration, testEngine),
    runConfiguration: testRunConfiguration,
    stopReason: 'halt-loop'
  },
  artifacts: {
    oracle: { traceOut: artifact('oracle/mars.out') },
    dut: {
      'verilog/traceOut': artifact('verilog/sim.out'),
      'logisim/preparedCircuit': artifact('logisim/cpu.circ')
    },
    source: { original: artifact('program.asm') }
  }
};

describe('manifest v1/v2 codec', () => {
  it('classifies v1 and v2 manifests and rejects unknown shapes', () => {
    expect(isKnownManifest(v1Manifest)).toBe(true);
    expect(isKnownManifest(v2Manifest)).toBe(true);
    expect(isKnownManifest(null)).toBe(false);
    expect(isKnownManifest({ version: 3, caseId: 'x' })).toBe(false);
    expect(isKnownManifest({ version: 1 })).toBe(false);
    expect(isKnownManifest({ version: 2, caseId: 'x', program: {}, oracle: {} })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, artifacts: { unexpected: {} } })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, metadata: { valid: 1 } })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, metadata: { valid: '' } })).toBe(false);
    expect(isKnownManifest({ ...v2Manifest, asmSnapshot: { ...v2Manifest.asmSnapshot, typo: true } })).toBe(false);
    expect(isKnownManifest({
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: { ...testRunConfiguration, maxStep: 1 }
      }
    })).toBe(false);
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
    expect(issues).toContain('program.machineCode.sha256 missing or invalid (image not dumped yet)');
  });

  it('reads early-v2 string artifacts but excludes them from replay closure', () => {
    const earlyV2: AsmCaseManifestV2 = {
      ...v2Manifest,
      artifacts: { oracle: { traceOut: 'oracle/mars.out' } }
    };
    expect(isKnownManifest(earlyV2)).toBe(true);
    expect(v2ReplayClosureIssues(earlyV2)).toContain(
      'artifacts.oracle.traceOut is an unhashed early-v2 reference'
    );
  });

  it('rejects run-configuration drift even when the stored digest looks valid', () => {
    const tampered: AsmCaseManifestV2 = {
      ...v2Manifest,
      oracle: {
        ...v2Manifest.oracle,
        runConfiguration: { ...testRunConfiguration, maxSteps: 1 }
      }
    };
    expect(v2ReplayClosureIssues(tampered)).toContain(
      'oracle.configurationHash does not match the engine/run configuration'
    );
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

  it('rejects replay inputs that are present but not bound to a configuration fingerprint', () => {
    const withInterruptDrift: AsmCaseManifestV2 = {
      ...v2Manifest,
      p7: { interruptSchedule: [0x3000] }
    };
    expect(v2ReplayClosureIssues(withInterruptDrift)).toContain(
      'oracle.runConfiguration.interruptSchedule does not match manifest.p7.interruptSchedule'
    );

    const withProbeAndDutMetadata: AsmCaseManifestV2 = {
      ...v2Manifest,
      p7: { probe: { version: 1 } },
      metadata: { 'source.seed': 'seed-1', 'dut.verilog.testbenchModule': 'mips_tb' }
    };
    expect(v2ReplayClosureIssues(withProbeAndDutMetadata)).toEqual(expect.arrayContaining([
      'manifest.p7.probe is not covered by a replay configuration fingerprint',
      'metadata contains replay-unbound keys: dut.verilog.testbenchModule'
    ]));
  });

  it('supports concurrent same-process atomic writes without temp-name collisions', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-concurrent-'));
    try {
      const manifestPath = path.join(dir, 'case.json');
      const variants = Array.from({ length: 8 }, (_, index) => ({
        ...v2Manifest,
        caseId: `case-${index}`
      }));
      await Promise.all(variants.map((manifest) => writeManifestAtomic(manifestPath, manifest)));
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as AsmCaseManifestV2;
      expect(variants.map((item) => item.caseId)).toContain(parsed.caseId);
      expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('verifies replay snapshot bytes and hashes inside the case directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-manifest-bundle-'));
    try {
      const asm = Buffer.from('nop');
      const code = Buffer.from('00000000');
      const trace = Buffer.from('@00003000: $ 1 <= 00000001\n');
      fs.writeFileSync(path.join(dir, 'program.asm'), asm);
      fs.writeFileSync(path.join(dir, 'code.txt'), code);
      fs.mkdirSync(path.join(dir, 'oracle'));
      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), trace);
      const complete: AsmCaseManifestV2 = {
        ...v2Manifest,
        asmSnapshot: {
          path: 'program.asm', bytes: asm.byteLength,
          sha256: crypto.createHash('sha256').update(asm).digest('hex')
        },
        program: {
          ...v2Manifest.program,
          imageFingerprint: crypto.createHash('sha256').update(code).digest('hex'),
          machineCode: {
            path: 'code.txt', bytes: code.byteLength, wordCount: 1, haltPc: 0x3004,
            sha256: crypto.createHash('sha256').update(code).digest('hex')
          }
        },
        artifacts: {
          oracle: {
            traceOut: {
              path: 'oracle/mars.out', bytes: trace.byteLength,
              sha256: crypto.createHash('sha256').update(trace).digest('hex')
            }
          }
        }
      };
      expect(await v2ReplayBundleIssues(complete, dir)).toEqual([]);
      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), 'corrupt');
      expect(await v2ReplayBundleIssues(complete, dir)).toEqual(expect.arrayContaining([
        expect.stringContaining('artifacts.oracle.traceOut')
      ]));
      fs.writeFileSync(path.join(dir, 'oracle', 'mars.out'), trace);
      fs.writeFileSync(path.join(dir, 'code.txt'), 'corrupt');
      expect(await v2ReplayBundleIssues(complete, dir)).toEqual(expect.arrayContaining([
        expect.stringContaining('program.machineCode')
      ]));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without throwing on a malformed runtime bundle value', async () => {
    await expect(v2ReplayBundleIssues({ version: 2 } as never, 'not-used')).resolves.toEqual([
      'manifest v2 structure is invalid or contains unknown fields'
    ]);
  });
});
