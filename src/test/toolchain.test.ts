import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {},
  window: {}
}));

import { buildIseEnvironment, isimExecutableName, marsTraceCapabilityCheck } from '../toolchain';

function successfulRun(stdout: string) {
  return {
    ok: true,
    exitCode: 0,
    commandLine: 'java -jar Mars.jar',
    cwd: process.cwd(),
    stdout,
    stderr: '',
    timedOut: false
  };
}

const coL1CapabilityTrace = [
  '@00003000: $ 1 <= 11223344',
  '@00003008: *00000000 <= 11223344',
  '@00003014: $ 3 <= 00001800',
  '@00003018: $ 4 <= 00002ffc',
  '@0000301c: $ 2 <= 00000002'
].join('\n');

const coL2CapabilityTrace = [
  '@PC00003000 -> lui $1,4386 (3c011122)',
  '\t\t$ 1 <= 11223344',
  '@PC00003008 -> sw $1,0($0) (ac010000)',
  '\t\t*00000000 <= 11223344',
  '@PC0000300c -> swl $1,1($0) (a8010001)',
  '\t\t*00000000 <= 11223344',
  '@PC00003010 -> swr $1,2($0) (b8010002)',
  '\t\t*00000000 <= 11223344',
  '@PC00003014 -> addu $3,$gp,$0 (03801821)',
  '\t\t$ 3 <= 00001800',
  '@PC00003018 -> addu $4,$sp,$0 (03a02021)',
  '\t\t$ 4 <= 00002ffc',
  '@PC0000301c -> ori $2,$0,2 (34020002)',
  '\t\t$ 2 <= 00000002'
].join('\n');

describe('toolchain helpers', () => {
  it('builds an ISE environment that exposes simulator GUI helpers on PATH', () => {
    const root = path.resolve('fake-ise-root');
    const inheritedPath = path.resolve('existing-path-entry');
    const env = buildIseEnvironment(root, { Path: inheritedPath });
    const pathValue = env.Path ?? env.PATH ?? '';
    const entries = pathValue.split(path.delimiter);

    expect(env.XILINX).toBe(root);
    expect(entries.slice(0, 3)).toEqual([
      path.join(root, 'bin', 'nt64'),
      path.join(root, 'bin', 'nt64', 'unwrapped'),
      path.join(root, 'lib', 'nt64')
    ]);
    expect(entries).toContain(inheritedPath);
  });

  it('names ISim compile outputs for the selected ISE toolchain platform', () => {
    expect(isimExecutableName('mips_tb', 'D:/ISE/bin/nt64/fuse.exe')).toBe('mips_tb.exe');
    expect(isimExecutableName('mips_tb', 'D:\\ISE\\bin\\nt\\fuse.exe')).toBe('mips_tb.exe');
    expect(isimExecutableName('mips_tb', '/opt/Xilinx/14.7/ISE_DS/ISE/bin/lin64/fuse')).toBe('mips_tb');
  });

  it('accepts coL1 and coL2 capability traces with the stable Compact $gp/$sp reset values', () => {
    expect(marsTraceCapabilityCheck(successfulRun(coL1CapabilityTrace), 1).ok).toBe(true);
    expect(marsTraceCapabilityCheck(successfulRun(coL2CapabilityTrace), 2).ok).toBe(true);
  });

  it('rejects either trace level when the stable Compact $gp/$sp reset contract is missing', () => {
    expect(marsTraceCapabilityCheck(
      successfulRun(coL1CapabilityTrace.replace('@00003018: $ 4 <= 00002ffc\n', '')),
      1
    ).ok).toBe(false);
    expect(marsTraceCapabilityCheck(
      successfulRun(coL2CapabilityTrace.replace('\t\t$ 3 <= 00001800\n', '')),
      2
    ).ok).toBe(false);
  });
});
