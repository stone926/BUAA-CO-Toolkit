import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  asmCaseId,
  asmCaseManifestVersion,
  asmCasePaths,
  machineCodeWordCount,
  mergeAsmCaseArtifacts,
  sha256Text
} from '../asmCaseStoreCore';
import type { AsmCaseManifest } from '../asmCaseStoreCore';

describe('ASM case store core helpers', () => {
  it('builds stable case ids from timestamp and ASM hash', () => {
    const id = asmCaseId(new Date('2026-06-12T03:04:05.006Z'), 'abcdef0123456789');
    expect(id).toBe('20260612T030405006Z-abcdef01');
  });

  it('builds the fixed case directory layout', () => {
    const paths = asmCasePaths('/work/cpu', 'case-id');
    expect(normalize(paths.caseDir)).toBe('/work/cpu/.co/cases/case-id');
    expect(normalize(paths.manifest)).toBe('/work/cpu/.co/cases/case-id/case.json');
    expect(normalize(paths.asm)).toBe('/work/cpu/.co/cases/case-id/program.asm');
    expect(normalize(paths.machineCode)).toBe('/work/cpu/.co/cases/case-id/code.txt');
    expect(normalize(paths.verilogDir)).toBe('/work/cpu/.co/cases/case-id/verilog');
    expect(normalize(paths.logisimDir)).toBe('/work/cpu/.co/cases/case-id/logisim');
  });

  it('hashes text and counts machine-code words', () => {
    expect(sha256Text('addi $1,$0,1\n')).toHaveLength(64);
    expect(machineCodeWordCount('34010001\n\n00000000\n')).toBe(2);
  });

  it('merges artifacts without dropping existing categories', () => {
    const manifest: AsmCaseManifest = {
      version: asmCaseManifestVersion,
      caseId: 'case',
      createdAt: '2026-06-12T00:00:00.000Z',
      profile: 'P4',
      originalAsmPath: '/work/a.asm',
      asmSnapshot: { path: '/work/.co/cases/case/program.asm', sha256: 'a'.repeat(64), bytes: 10 },
      source: { kind: 'selected' },
      artifacts: {
        verilog: { simOut: '/work/.co/cases/case/verilog/a.sim.out' }
      }
    };

    const merged = mergeAsmCaseArtifacts(manifest, 'logisim', { rom: '/work/.co/cases/case/logisim/a.txt' });
    expect(merged.artifacts?.verilog?.simOut).toContain('a.sim.out');
    expect(merged.artifacts?.logisim?.rom).toContain('a.txt');
  });
});

function normalize(file: string): string {
  return file.split(path.sep).join('/');
}
