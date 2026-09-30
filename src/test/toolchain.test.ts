import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runTool: vi.fn(),
  tempDir: '',
  profile: 'P2',
  mode: 'auto'
}));

vi.mock('vscode', () => ({ workspace: {}, window: {} }));
vi.mock('../config', () => ({
  ensureConcreteProfile: vi.fn(),
  getJava: () => 'java',
  getLogisimJar: () => 'Logisim.jar',
  getMarsJar: () => 'C:/课程工具/MARS 4.5.jar',
  getMemoryConfiguration: () => 'Default',
  getMipsEngine: () => mocks.mode,
  getProfile: () => mocks.profile
}));
vi.mock('../process', () => ({ runTool: mocks.runTool }));
vi.mock('../fsUtil', () => ({
  coTmpDir: () => mocks.tempDir,
  cleanupCoTmp: vi.fn(async () => undefined),
  isFile: vi.fn(async () => true)
}));

import { checkToolchain, marsAssemblyCapabilityCheck, marsExecutionCapabilityCheck } from '../toolchain';

function successfulRun(stdout = '', stderr = '') {
  return {
    ok: true, exitCode: 0, commandLine: 'java -jar MARS.jar', cwd: process.cwd(),
    stdout, stderr, timedOut: false
  };
}

const hexText = '34043039\n34020001\n0000000c\n3402000a\n0000000c\n';
const output = { append: vi.fn(), appendLine: vi.fn() } as never;

beforeEach(async () => {
  mocks.tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-official-mars-test-'));
  mocks.profile = 'P2';
  mocks.mode = 'auto';
  mocks.runTool.mockReset();
  mocks.runTool.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('-version')) {
      return successfulRun('', 'openjdk version');
    }
    if (args.includes('dump')) {
      await fs.promises.writeFile(args[args.indexOf('HexText') + 1], hexText, 'utf8');
      return successfulRun();
    }
    return successfulRun('12345');
  });
});

afterEach(async () => {
  await fs.promises.rm(mocks.tempDir, { recursive: true, force: true });
});

describe('official MARS capability probes', () => {
  it('checks standard assembly, HexText, and execution without course-specific options', async () => {
    const checks = await checkToolchain(output, undefined, { nonInteractive: true });
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ['Java', true], ['MARS', true], ['MARS assemble/HexText', true], ['MARS run', true]
    ]);
    const marsCalls = mocks.runTool.mock.calls.filter((call) => call[1].includes('-jar'));
    expect(marsCalls).toHaveLength(2);
    for (const [, args] of marsCalls) {
      expect(args).toEqual(expect.arrayContaining(['ae1', 'se1', 'Default', 'C:/课程工具/MARS 4.5.jar']));
      expect(args.join(' ')).not.toMatch(/coL|efc|p7irq|CompactLargeText/);
    }
    expect(marsCalls[0][1]).toEqual(expect.arrayContaining(['a', 'dump', '.text', 'HexText']));
    expect(marsCalls[1][1]).toContain('1000');
  });

  it('fails a zero-exit assembly diagnostic even if a dump was produced', async () => {
    mocks.runTool.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('dump')) {
        await fs.promises.writeFile(args[args.indexOf('HexText') + 1], hexText, 'utf8');
        return successfulRun('', 'Error in capability.asm line 2: Invalid operand');
      }
      return successfulRun();
    });
    const checks = await checkToolchain(output);
    expect(checks.at(-1)).toMatchObject({ name: 'MARS assemble/HexText', ok: false });
    expect(mocks.runTool.mock.calls.filter((call) => call[1].includes('-jar'))).toHaveLength(1);
  });

  it.each(['', 'not HexText', hexText.replace('34043039', '34043038'), `${hexText}00000000\n`])(
    'rejects missing, malformed, wrong, or extra dump words', (dump) => {
      expect(marsAssemblyCapabilityCheck(successfulRun(), dump).ok).toBe(false);
    }
  );

  it('requires successful processes and expected syscall output', () => {
    expect(marsExecutionCapabilityCheck(successfulRun('12345\n')).ok).toBe(true);
    expect(marsExecutionCapabilityCheck(successfulRun('')).ok).toBe(false);
    expect(marsExecutionCapabilityCheck(successfulRun('12345', 'Error: simulation failed')).ok).toBe(false);
    expect(marsExecutionCapabilityCheck({ ...successfulRun('12345'), ok: false }).ok).toBe(false);
    expect(marsAssemblyCapabilityCheck({ ...successfulRun(), ok: false }, hexText).ok).toBe(false);
  });

  it('accepts harmless Java preferences warnings without hiding MARS diagnostics', () => {
    const warning = 'WARNING: Could not open/create prefs root node';
    expect(marsAssemblyCapabilityCheck(successfulRun('', warning), hexText).ok).toBe(true);
    expect(marsExecutionCapabilityCheck(successfulRun('12345', warning)).ok).toBe(true);
    expect(marsAssemblyCapabilityCheck(successfulRun('Invalid Command Argument: mc'), hexText).ok).toBe(false);
  });

  it.each(['auto', 'builtin', 'mars', 'verify-both'])(
    'does not launch MARS probes for a P7 course profile with %s settings', async (mode) => {
      mocks.profile = 'P7';
      mocks.mode = mode;
      const checks = await checkToolchain(output);
      expect(mocks.runTool).not.toHaveBeenCalled();
      expect(checks.map((check) => check.name)).toEqual(['Verilog simulator']);
    }
  );
});
