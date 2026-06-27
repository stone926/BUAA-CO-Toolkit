import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as path from 'path';

type ProjectProfile = string;

// Mock vscode — needed because mips.ts imports from 'vscode'
vi.mock('vscode', () => ({
  Uri: {
    parse(s: string) {
      return { scheme: 'file', fsPath: s, path: s };
    },
    file(s: string) {
      return { scheme: 'file', fsPath: s, path: s };
    }
  },
  window: {
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showWarningMessage: vi.fn()
  },
  workspace: {
    getConfiguration() {
      return {
        get() { return undefined; },
        inspect() { return {}; }
      };
    }
  },
  ConfigurationTarget: { Workspace: 1, Global: 2 }
}));

// Stored return values used by mocked config functions
const profileStore = new Map<string, ProjectProfile>();
const memoryConfigStore = new Map<string, string>();
const delayedBranchingStore = new Map<string, boolean>();

vi.mock('../../config', () => ({
  getProfile(resource?: any): ProjectProfile {
    const key = resource?.fsPath ?? '';
    return profileStore.get(key) ?? 'P5';
  },
  getMemoryConfiguration(resource?: any): string {
    const key = resource?.fsPath ?? '';
    return memoryConfigStore.get(key) ?? 'FixedCompactLargeText';
  },
  useDelayedBranching(resource?: any): boolean {
    const key = resource?.fsPath ?? '';
    return delayedBranchingStore.get(key) ?? false;
  },
  getMipsExtraArgs(_resource?: any): string[] {
    return [];
  },
  getJava() { return 'java'; },
  getMarsJar() { return '/opt/mars/Mars.jar'; },
  ensureConcreteProfile() { return undefined; },
  getMachineCode() { return 'code.txt'; }
}));

import { buildMarsArgs } from '../../mips';

function makeUri(fsPath = '/test/asm.asm'): any {
  return { scheme: 'file', fsPath, path: fsPath };
}

function setProfile(uri: any, profile: string): void {
  profileStore.set(uri?.fsPath ?? '', profile);
}

function setMemoryConfig(uri: any, config: string): void {
  memoryConfigStore.set(uri?.fsPath ?? '', config);
}

function setDelayedBranching(uri: any, value: boolean): void {
  delayedBranchingStore.set(uri?.fsPath ?? '', value);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.some((a) => a.toLowerCase() === flag.toLowerCase());
}

describe('buildMarsArgs', () => {
  const asmUri = makeUri('/test/asm/test.asm');
  const marsJar = '/opt/mars/Mars.jar';

  beforeEach(() => {
    profileStore.clear();
    memoryConfigStore.clear();
    delayedBranchingStore.clear();
    // All stores cleared above
  });

  describe('run mode', () => {
    it('uses -jar for non-P7', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(args[0]).toBe('-jar');
      expect(args[1]).toBe(marsJar);
    });

    it('produces nc (no copyright) and mc (memory config) flags', () => {
      setProfile(asmUri, 'P5');
      setMemoryConfig(asmUri, 'FixedCompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(hasFlag(args, 'nc')).toBe(true);
      expect(hasFlag(args, 'mc')).toBe(true);
      expect(args).toContain('FixedCompactLargeText');
    });

    it('includes db when delayed branching is profile-enabled', () => {
      setProfile(asmUri, 'P5');
      setDelayedBranching(asmUri, true);

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(hasFlag(args, 'db')).toBe(true);
    });

    it('omits db when delayed branching is disabled', () => {
      setProfile(asmUri, 'P4');
      setDelayedBranching(asmUri, false);

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(hasFlag(args, 'db')).toBe(false);
    });

    it('appends coL1 when traceOutput is requested', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'run', { traceOutput: true });

      expect(hasFlag(args, 'coL1')).toBe(true);
    });

    it('does not append coL1 when traceOutput is false', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(hasFlag(args, 'coL1')).toBe(false);
    });

    it('appends asm file path at the end for run mode', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(args[args.length - 1]).toBe('/test/asm/test.asm');
    });

    it('appends efc and p7irq for P7 course-trace run', () => {
      setProfile(asmUri, 'P7');
      setMemoryConfig(asmUri, 'CompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {
        courseTrace: true,
        interruptSchedule: [0x3010]
      });

      expect(hasFlag(args, 'efc')).toBe(true);
      expect(args.some((a) => a.startsWith('p7irq='))).toBe(true);
    });

    it('omits efc and p7irq for non-P7 run', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {
        courseTrace: true,
        interruptSchedule: [0x3010]
      });

      expect(hasFlag(args, 'efc')).toBe(false);
      expect(args.some((a) => a.startsWith('p7irq='))).toBe(false);
    });

    it('omits p7irq when interruptSchedule is empty', () => {
      setProfile(asmUri, 'P7');
      setMemoryConfig(asmUri, 'CompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {
        courseTrace: true,
        interruptSchedule: []
      });

      expect(hasFlag(args, 'efc')).toBe(true);
      expect(args.some((a) => a.startsWith('p7irq='))).toBe(false);
    });

    it('fires p7irq one slot earlier (target - 4) for MARS prevIRQ semantics', () => {
      setProfile(asmUri, 'P7');
      setMemoryConfig(asmUri, 'CompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'run', {
        courseTrace: true,
        interruptSchedule: [0x3010]
      });

      const p7irq = args.find((a) => a.startsWith('p7irq='));
      // Target PC 0x3010 → p7irq should fire at 0x300c (one instruction earlier)
      expect(p7irq).toContain('0x300c');
    });
  });

  describe('dumpText mode', () => {
    it('does not append asm file path', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'dumpText', {});

      expect(args.some((a) => a.endsWith('.asm') || a.endsWith('.s'))).toBe(false);
    });

    it('does not include coL1, efc, or p7irq', () => {
      setProfile(asmUri, 'P7');
      setMemoryConfig(asmUri, 'CompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'dumpText', {
        courseTrace: true,
        interruptSchedule: [0x3010]
      });

      expect(hasFlag(args, 'coL1')).toBe(false);
      expect(hasFlag(args, 'efc')).toBe(false);
      expect(args.some((a) => a.startsWith('p7irq='))).toBe(false);
    });
  });

  describe('dumpKernel mode', () => {
    it('does not append asm file path', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'dumpKernel', {});

      expect(args.some((a) => a.endsWith('.asm') || a.endsWith('.s'))).toBe(false);
    });

    it('does not include coL1, efc, or p7irq', () => {
      setProfile(asmUri, 'P7');
      setMemoryConfig(asmUri, 'CompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'dumpKernel', {
        courseTrace: true,
        interruptSchedule: [0x3010]
      });

      expect(hasFlag(args, 'coL1')).toBe(false);
      expect(hasFlag(args, 'efc')).toBe(false);
      expect(args.some((a) => a.startsWith('p7irq='))).toBe(false);
    });
  });

  describe('P7 RI instruction mode (-cp classpath)', () => {
    it('uses -cp instead of -jar when p7RiInstruction is set', () => {
      setProfile(asmUri, 'P7');
      setMemoryConfig(asmUri, 'CompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'run', { p7RiInstruction: true });

      expect(args[0]).toBe('-cp');
      // On Windows, path.delimiter is ';' — the classpath should contain both marsJar and the resource dir
      expect(args[1]).toContain(marsJar);
      expect(args[1]).toContain(path.delimiter);
      expect(args[2]).toBe('Mars');
    });

    it('includes cl flag with _co_internal_unknown_instruction.class', () => {
      setProfile(asmUri, 'P7');
      setMemoryConfig(asmUri, 'CompactLargeText');

      const args = buildMarsArgs(asmUri, marsJar, 'run', { p7RiInstruction: true });

      // Find the cl flag
      const clIdx = args.findIndex((a) => a === 'cl');
      expect(clIdx).toBeGreaterThan(0);
      expect(args[clIdx + 1]).toContain('_co_internal_unknown_instruction');
      expect(args[clIdx + 1]).toContain('.class');
    });
  });
});
