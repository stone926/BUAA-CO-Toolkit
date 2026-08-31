import { describe, expect, it } from 'vitest';
import type { RunResult } from '../../types';
import { parseIverilogDiagnosticRecord } from '../../verilog/iverilogDiagnostics';
import {
  createVerilogSimulationFailure,
  missingVerilogSimulationOutputFailure,
  normalizeVerilogSimulationFailure,
  verilogSimulationFailureMessage
} from '../../verilog/simulationDiagnostic';

function failedRun(overrides: Partial<RunResult> = {}): RunResult {
  return {
    ok: false,
    exitCode: 26,
    commandLine: 'E:/SECRET/bin/iverilog.exe --secret',
    cwd: 'E:/SECRET/work',
    stdout: '',
    stderr: '',
    timedOut: false,
    stopped: false,
    ...overrides
  };
}

describe('Verilog simulation diagnostics', () => {
  it('recognizes the severity prefixes emitted by VVP without treating them as part of the path', () => {
    expect(parseIverilogDiagnosticRecord('ERROR: E:/work/tb.v:12: failed assertion')).toEqual({
      file: 'E:/work/tb.v',
      line: 12,
      severity: 'error',
      message: 'failed assertion'
    });
    expect(parseIverilogDiagnosticRecord('WARNING: /work/tb.v:8: signal is X')).toEqual({
      file: '/work/tb.v',
      line: 8,
      severity: 'warning',
      message: 'signal is X'
    });
    expect(parseIverilogDiagnosticRecord('FATAL: C:\\work\\tb.v:5:2: stopped')).toEqual({
      file: 'C:\\work\\tb.v',
      line: 5,
      column: 2,
      severity: 'error',
      message: 'stopped'
    });
  });

  it('sanitizes prefixed Windows and POSIX paths at the public diagnostic boundary', () => {
    const windowsInside = createVerilogSimulationFailure(
      'iverilog',
      'simulate',
      failedRun({ stderr: 'ERROR: E:\\workspace\\rtl\\tb.v:12: failed assertion' }),
      'E:\\workspace'
    );
    const windowsOutside = createVerilogSimulationFailure(
      'iverilog',
      'simulate',
      failedRun({ stderr: 'ERROR: C:\\Users\\private-user\\tb.v:13: failed assertion' }),
      'E:\\workspace'
    );
    const posixInside = createVerilogSimulationFailure(
      'iverilog',
      'simulate',
      failedRun({ stderr: 'FATAL: /workspace/rtl/tb.v:14: failed assertion' }),
      '/workspace'
    );
    const posixOutside = createVerilogSimulationFailure(
      'iverilog',
      'simulate',
      failedRun({ stderr: 'WARNING: /Users/private-user/tb.v:15: failed assertion' }),
      '/workspace'
    );

    expect(windowsInside.diagnostic?.file).toBe('rtl/tb.v');
    expect(windowsOutside.diagnostic?.file).toBe('tb.v');
    expect(posixInside.diagnostic?.file).toBe('rtl/tb.v');
    expect(posixOutside.diagnostic?.file).toBe('tb.v');
    expect(JSON.stringify({ windowsOutside, posixOutside }))
      .not.toMatch(/private-user|C:\\|E:\\|\/Users\//);
  });

  it('extracts an actionable Icarus diagnostic with a workspace-relative Windows path', () => {
    const failure = createVerilogSimulationFailure(
      'iverilog',
      'compile',
      failedRun({
        stderr: 'E:\\课程 workspace\\rtl dir\\CPU.v:449: error: Unable to bind wire/reg/memory `D_fixedRD1_reg`'
      }),
      'E:\\课程 workspace'
    );

    expect(failure).toEqual({
      phase: 'compile',
      reason: 'exit',
      exitCode: 26,
      diagnostic: {
        file: 'rtl dir/CPU.v',
        line: 449,
        message: 'Unable to bind wire/reg/memory `D_fixedRD1_reg`'
      }
    });
    expect(verilogSimulationFailureMessage(failure, 'iverilog')).toBe(
      'Icarus 编译失败（退出码 26）：rtl dir/CPU.v:449: Unable to bind wire/reg/memory `D_fixedRD1_reg`'
    );
  });

  it('turns Icarus declaration-after-use context into a direct repair hint', () => {
    const failure = createVerilogSimulationFailure(
      'iverilog',
      'compile',
      failedRun({
        stderr: [
          "E:\\work\\CPU.v:449: error: Unable to bind wire/reg/memory `D_fixedRD1_reg' in `co_generated_p7_auto_tb.uut.CPU'",
          'E:\\work\\CPU.v:455:      : A symbol with that name was declared here. Check for declaration after use.'
        ].join('\r\n')
      }),
      'E:\\work'
    );

    expect(verilogSimulationFailureMessage(failure, 'iverilog')).toBe(
      'Icarus 编译失败（退出码 26）：CPU.v:449: Unable to bind wire/reg/memory “D_fixedRD1_reg”；同一符号在第 455 行才声明（请将声明移到首次使用之前）'
    );
  });

  it('extracts a path-safe actionable ISim fuse diagnostic', () => {
    const failure = createVerilogSimulationFailure(
      'isim',
      'compile',
      failedRun({
        exitCode: 1,
        stderr: 'ERROR:HDLCompiler:806 - "E:/work/rtl/CPU.v" Line 28: Syntax error near "endmodule".'
      }),
      'E:/work'
    );

    expect(failure).toEqual({
      phase: 'compile',
      reason: 'exit',
      exitCode: 1,
      diagnostic: {
        file: 'rtl/CPU.v',
        line: 28,
        message: 'Syntax error near "endmodule".'
      }
    });
    expect(verilogSimulationFailureMessage(failure, 'isim')).toBe(
      'ISim 编译失败（退出码 1）：rtl/CPU.v:28: Syntax error near "endmodule".'
    );
    expect(JSON.stringify(failure)).not.toContain('E:/work');
  });

  it('keeps only the basename for paths outside the workspace and redacts raw paths in messages', () => {
    const failure = createVerilogSimulationFailure(
      'iverilog',
      'compile',
      failedRun({
        stderr: [
          'C:\\Users\\private-user\\outside\\secret.v:8: error: Include file E:\\SECRET ROOT\\defs.vh not found',
          '26 error(s) during elaboration.'
        ].join('\r\n')
      }),
      'E:\\workspace'
    );
    const serialized = JSON.stringify(failure);

    expect(failure.diagnostic).toEqual({
      file: 'secret.v',
      line: 8,
      message: 'Include file <path>'
    });
    expect(serialized).not.toMatch(/private-user|SECRET ROOT|C:\\|E:\\/);
  });

  it('handles POSIX paths, columns, warnings, and compiler errors deterministically', () => {
    const failure = createVerilogSimulationFailure(
      'iverilog',
      'compile',
      failedRun({
        stderr: [
          '/workspace/rtl/top.v:2: warning: implicit wire',
          '/workspace/rtl/top.v:12:4: sorry: malformed statement'
        ].join('\n')
      }),
      '/workspace'
    );

    expect(failure.diagnostic).toEqual({
      file: 'rtl/top.v',
      line: 12,
      column: 4,
      message: 'malformed statement'
    });
  });

  it('classifies timeout, cancellation, and output limits without exposing raw process text', () => {
    const timeout = createVerilogSimulationFailure('iverilog', 'simulate', failedRun({
      exitCode: null,
      timedOut: true,
      stopped: true,
      stopReason: 'timeout',
      stderr: 'E:/SECRET/timeout.log'
    }));
    const cancelled = createVerilogSimulationFailure('iverilog', 'compile', failedRun({
      exitCode: null,
      stopped: true,
      stopReason: 'aborted'
    }));
    const limited = createVerilogSimulationFailure('iverilog', 'simulate', failedRun({
      exitCode: null,
      stopped: true,
      stopReason: 'stderr-limit'
    }));

    expect(timeout).toEqual({ phase: 'simulate', reason: 'timeout' });
    expect(cancelled).toEqual({ phase: 'compile', reason: 'cancelled' });
    expect(limited).toEqual({ phase: 'simulate', reason: 'output-limit' });
    expect(verilogSimulationFailureMessage(timeout, 'iverilog')).toBe('Icarus 仿真超时');
  });

  it('revalidates untrusted report fields and bounds their public size', () => {
    const normalized = normalizeVerilogSimulationFailure({
      phase: 'compile',
      reason: 'exit',
      diagnostic: {
        file: 'E:/SECRET/user/CPU.v',
        line: 1,
        message: `bad ${'x'.repeat(500)} C:/SECRET/tail`
      }
    });
    const serialized = JSON.stringify(normalized);

    expect(normalized.diagnostic?.file).toBe('CPU.v');
    expect(normalized.diagnostic?.message.length).toBeLessThanOrEqual(320);
    expect(serialized).not.toMatch(/SECRET|E:\/|C:\//);
  });

  it('does not let file URIs bypass the public path boundary', () => {
    const normalized = normalizeVerilogSimulationFailure({
      phase: 'compile',
      reason: 'exit',
      diagnostic: {
        file: 'file:///Users/private-user/project/secret.v',
        line: 7,
        message: 'included from file:///Users/private-user/project/defs.vh'
      }
    });

    expect(normalized.diagnostic).toEqual({
      file: 'secret.v',
      line: 7,
      message: 'included from <path>'
    });
    expect(JSON.stringify(normalized)).not.toContain('private-user');
  });

  it('describes a successful process that failed to produce a trace separately', () => {
    expect(verilogSimulationFailureMessage(missingVerilogSimulationOutputFailure(), 'isim'))
      .toBe('ISim 输出处理未生成可读取的结果');
  });
});
