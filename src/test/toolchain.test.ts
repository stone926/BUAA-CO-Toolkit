import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {},
  window: {}
}));

import { marsTraceCapabilityCheck } from '../toolchain';

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
