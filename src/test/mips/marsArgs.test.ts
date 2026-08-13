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
const extraArgsStore = new Map<string, string[]>();

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
  getMipsExtraArgs(resource?: any): string[] {
    return extraArgsStore.get(resource?.fsPath ?? '') ?? [];
  },
  getJava() { return 'java'; },
  getMarsJar() { return '/opt/mars/Mars.jar'; },
  ensureConcreteProfile() { return undefined; },
  getMachineCode() { return 'code.txt'; }
}));

import { p7ExceptionHandlerAddress, p7KernelTextDumpEndAddress } from '../../courseTesting/p7Hardware';
import { buildMarsArgs, courseUserTextDumpRange, p7KernelTextDumpRange } from '../../mips';

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

function setExtraArgs(uri: any, value: string[]): void {
  extraArgsStore.set(uri?.fsPath ?? '', value);
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
    extraArgsStore.clear();
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

    it('forces profile delay-slot semantics for course traces', () => {
      setProfile(asmUri, 'P5');
      setDelayedBranching(asmUri, false);
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'run', { courseTrace: true }), 'db')).toBe(true);

      setProfile(asmUri, 'P4');
      setDelayedBranching(asmUri, true);
      setExtraArgs(asmUri, ['db']);
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'run', { courseTrace: true }), 'db')).toBe(false);
    });

    it('never masks signed-overflow failures in a course-trace oracle', () => {
      for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
        setProfile(asmUri, profile);
        if (profile === 'P7') {
          setMemoryConfig(asmUri, 'CompactLargeText');
        }
        setExtraArgs(asmUri, ['ig']);
        expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'run', { courseTrace: true }), 'ig'), profile).toBe(false);
      }
    });

    it('makes modified-MARS assembly and simulation failures nonzero for course traces', () => {
      setProfile(asmUri, 'P6');
      const courseArgs = buildMarsArgs(asmUri, marsJar, 'run', { courseTrace: true });
      expect(courseArgs).toContain('ae1');
      expect(courseArgs).toContain('se1');

      const ordinaryArgs = buildMarsArgs(asmUri, marsJar, 'run', {});
      expect(ordinaryArgs).not.toContain('ae1');
      expect(ordinaryArgs).not.toContain('se1');
    });

    it('does not require unreleased course-only flags from stable modified MARS', () => {
      setProfile(asmUri, 'P6');
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'run', { courseTrace: true }), 'coZeroGpr')).toBe(false);
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'run', { courseTrace: true }), 'coStrictData')).toBe(false);
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'run', {}), 'coZeroGpr')).toBe(false);
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'run', {}), 'coStrictData')).toBe(false);
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'dumpText', { courseTrace: true }), 'coZeroGpr')).toBe(false);
      expect(hasFlag(buildMarsArgs(asmUri, marsJar, 'dumpText', { courseTrace: true }), 'coStrictData')).toBe(false);
    });

    it('appends coL1 when traceOutput is requested', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'run', { traceOutput: true });

      expect(hasFlag(args, 'coL1')).toBe(true);
    });

    it('appends coL2 instead of coL1 when detailed trace is requested', () => {
      setProfile(asmUri, 'P5');

      const args = buildMarsArgs(asmUri, marsJar, 'run', { traceOutput: true, traceLevel: 2 });

      expect(hasFlag(args, 'coL2')).toBe(true);
      expect(hasFlag(args, 'coL1')).toBe(false);
    });

    it('passes a deterministic native max-step limit only to course-trace runs', () => {
      for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
        setProfile(asmUri, profile);
        if (profile === 'P7') {
          setMemoryConfig(asmUri, 'CompactLargeText');
        }
        const courseArgs = buildMarsArgs(asmUri, marsJar, 'run', {
          traceOutput: true,
          maxSteps: 8064,
          haltPc: 0x3ffc
        });

        expect(courseArgs, profile).toContain('8064');
        expect(courseArgs.some((arg) => arg.toLowerCase().startsWith('cohalt=')), profile).toBe(false);
        expect(courseArgs[courseArgs.length - 1], profile).toBe('/test/asm/test.asm');
      }

      setProfile(asmUri, 'P5');
      const ordinaryArgs = buildMarsArgs(asmUri, marsJar, 'run', { maxSteps: 8064 });

      expect(ordinaryArgs).not.toContain('8064');
      expect(ordinaryArgs.some((arg) => arg.toLowerCase().startsWith('cohalt='))).toBe(false);
    });

    it('raises max-step values 1..31 above stable MARS register-display ambiguity', () => {
      setProfile(asmUri, 'P6');
      for (let maxSteps = 1; maxSteps <= 31; maxSteps++) {
        const args = buildMarsArgs(asmUri, marsJar, 'run', {
          traceOutput: true,
          traceLevel: 2,
          maxSteps,
          haltPc: 0x3000
        });
        expect(args[args.length - 2], `maxSteps=${maxSteps}`).toBe('32');
      }

      for (const maxSteps of [32, 33]) {
        const unambiguous = buildMarsArgs(asmUri, marsJar, 'run', {
          traceOutput: true,
          traceLevel: 2,
          maxSteps,
          haltPc: 0x3000
        });
        expect(unambiguous[unambiguous.length - 2]).toBe(String(maxSteps));
      }
    });

    it('does not pass any user extra arguments to a course-trace oracle', () => {
      setProfile(asmUri, 'P6');
      setExtraArgs(asmUri, [
        'mc', 'InjectedConfig', 'cl', 'Injected.class', 'coL1', 'coL2',
        'p7irq=0x3000', 'efc', 'smc', 'db', 'ig', 'coZeroGpr', 'coStrictData', 'coHalt=0x6666'
      ]);

      const args = buildMarsArgs(asmUri, marsJar, 'run', { traceOutput: true, traceLevel: 2 });

      expect(args.filter((arg) => arg.toLowerCase() === 'mc')).toHaveLength(1);
      expect(args.filter((arg) => arg.toLowerCase() === 'db')).toHaveLength(1);
      expect(args.filter((arg) => arg.toLowerCase() === 'ig')).toHaveLength(0);
      expect(args.filter((arg) => arg.toLowerCase() === 'col2')).toHaveLength(1);
      expect(args.filter((arg) => arg.toLowerCase() === 'cozerogpr')).toHaveLength(0);
      expect(args.filter((arg) => arg.toLowerCase() === 'costrictdata')).toHaveLength(0);
      expect(args.some((arg) => arg.toLowerCase().startsWith('cohalt='))).toBe(false);
      expect(args).not.toContain('InjectedConfig');
      expect(args).not.toContain('Injected.class');
      expect(hasFlag(args, 'cl')).toBe(false);
      expect(hasFlag(args, 'coL1')).toBe(false);
      expect(hasFlag(args, 'efc')).toBe(false);
      expect(hasFlag(args, 'smc')).toBe(false);
      expect(args.some((arg) => arg.toLowerCase().startsWith('p7irq='))).toBe(false);
    });

    it('keeps user extra arguments for ordinary MARS runs', () => {
      setProfile(asmUri, 'P4');
      setExtraArgs(asmUri, ['smc', 'custom-option']);

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(args).toContain('smc');
      expect(args).toContain('custom-option');
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

    it('keeps delayed branching, memory config, and asm path arguments in a stable order', () => {
      setProfile(asmUri, 'P5');
      setMemoryConfig(asmUri, 'FixedCompactLargeText');
      setDelayedBranching(asmUri, true);

      const args = buildMarsArgs(asmUri, marsJar, 'run', {});

      expect(args).toEqual([
        '-jar',
        marsJar,
        'nc',
        'mc',
        'FixedCompactLargeText',
        'db',
        '/test/asm/test.asm'
      ]);
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

    it('does not pass user extra arguments while preparing a course-trace dump', () => {
      setProfile(asmUri, 'P5');
      setExtraArgs(asmUri, ['smc', 'coL2', 'cl', 'Injected.class']);

      const args = buildMarsArgs(asmUri, marsJar, 'dumpText', { courseTrace: true });

      expect(args).not.toContain('smc');
      expect(args).not.toContain('coL2');
      expect(args).not.toContain('cl');
      expect(args).not.toContain('Injected.class');
      expect(args).toContain('ae1');
      expect(args).toContain('se1');
    });
  });

  describe('dumpKernel mode', () => {
    it('uses exclusive course dump bounds without mixing contiguous P7 user and kernel text', () => {
      const format = (value: number) => `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
      expect(courseUserTextDumpRange('P6')).toBe(`${format(0x3000)}-${format(p7KernelTextDumpEndAddress)}`);
      expect(courseUserTextDumpRange('P7')).toBe(`${format(0x3000)}-${format(p7ExceptionHandlerAddress)}`);
      expect(p7KernelTextDumpRange()).toBe(`${format(p7ExceptionHandlerAddress)}-${format(p7KernelTextDumpEndAddress)}`);
    });

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
