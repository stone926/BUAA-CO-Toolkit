import { describe, expect, it } from 'vitest';
import {
  courseTraceMemoryConfigurationError,
  courseTraceMemoryConfigurationErrorForEngine,
  formatAutomaticToolchainFailure,
  formatToolchainFailure,
  requiredCourseTraceToolchainChecks,
  requiredToolchainFailures
} from '../courseTestToolchain';

describe('course test toolchain helpers', () => {
  it.each(['auto', 'builtin', 'mars', 'verify-both'] as const)('ignores MARS memory settings for course engine %s', (mode) => {
    for (const profile of ['P3', 'P4', 'P5', 'P6', 'P7'] as const) {
      expect(courseTraceMemoryConfigurationError(profile, 'Default')).toBeUndefined();
      expect(courseTraceMemoryConfigurationErrorForEngine(profile, mode, 'Default')).toBeUndefined();
      expect(courseTraceMemoryConfigurationErrorForEngine(profile, mode, 'CompactLargeText')).toBeUndefined();
    }
  });

  it('derives continuous and Logisim preflight checks from the effective engine tools', () => {
    expect([...requiredCourseTraceToolchainChecks('P3', 'builtin', 'Default')])
      .toEqual(['Java', 'Logisim']);
    expect([...requiredCourseTraceToolchainChecks('P4', 'auto', 'Default')])
      .toEqual(['Verilog simulator']);
    expect([...requiredCourseTraceToolchainChecks('P4', 'mars', 'FixedCompactLargeText')])
      .toEqual(['Verilog simulator']);
    expect([...requiredCourseTraceToolchainChecks('P7', 'verify-both', 'CompactLargeText')])
      .toEqual(['Verilog simulator']);
  });

  it('formats failed toolchain checks with optional suggestions', () => {
    expect(formatToolchainFailure({ name: 'MARS', ok: false, detail: '未配置' })).toBe('MARS 未配置');
    expect(formatToolchainFailure({ name: 'Icarus Verilog', ok: false, detail: '不可用', suggestion: '检查插件安装' }))
      .toBe('Icarus Verilog 不可用（检查插件安装）');
  });

  it('keeps automatic toolchain failures free of local paths and raw details', () => {
    const message = formatAutomaticToolchainFailure({
      name: 'Icarus Verilog',
      ok: false,
      detail: 'E:/SECRET_RUNTIME_PATH/bin/iverilog.exe',
      suggestion: '检查插件安装'
    });

    expect(message).toBe('Icarus Verilog 不可用，请检查工具链设置');
    expect(message).not.toContain('SECRET_RUNTIME_PATH');
  });

  it('treats a required capability that was never checked as a failure', () => {
    const failures = requiredToolchainFailures(
      [{ name: 'Java', ok: true, detail: 'ok' }],
      new Set(['Java', 'Logisim'])
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'Logisim', ok: false, detail: '未执行能力检查' });
  });
});
