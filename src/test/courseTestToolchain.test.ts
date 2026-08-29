import { describe, expect, it } from 'vitest';
import {
  courseTraceMemoryConfigurationError,
  courseTraceMemoryConfigurationErrorForEngine,
  formatAutomaticToolchainFailure,
  formatToolchainFailure,
  MARS_P7_CHECK,
  requiredCourseTraceToolchainChecks,
  requiredToolchainFailures
} from '../courseTestToolchain';

describe('course test toolchain helpers', () => {
  it('accepts the expected trace memory configurations', () => {
    expect(courseTraceMemoryConfigurationError('P7', 'CompactLargeText')).toBeUndefined();
    expect(courseTraceMemoryConfigurationError('P6', 'FixedCompactLargeText')).toBeUndefined();
    expect(courseTraceMemoryConfigurationError('P6', 'CompactLargeText')).toBeUndefined();
  });

  it('reports profile-specific trace memory configuration errors', () => {
    expect(courseTraceMemoryConfigurationError('P7', 'Default')).toBe('P7 持续生成测试必须使用 CompactLargeText，当前为 Default');
    expect(courseTraceMemoryConfigurationError('P5', 'Default')).toBe('非 P7 Trace 测试应使用 FixedCompactLargeText 或 CompactLargeText，当前为 Default');
  });

  it('skips MARS memory-layout checks for builtin lanes', () => {
    expect(courseTraceMemoryConfigurationErrorForEngine('P3', 'auto', 'Default')).toBeUndefined();
    expect(courseTraceMemoryConfigurationErrorForEngine('P7', 'builtin', 'Default')).toBeUndefined();
    expect(courseTraceMemoryConfigurationErrorForEngine('P6', 'mars', 'Default'))
      .toBe('非 P7 Trace 测试应使用 FixedCompactLargeText 或 CompactLargeText，当前为 Default');
    expect(courseTraceMemoryConfigurationErrorForEngine('P7', 'verify-both', 'Default'))
      .toBe('P7 持续生成测试必须使用 CompactLargeText，当前为 Default');
  });

  it('derives continuous and Logisim preflight checks from the effective engine tools', () => {
    expect([...requiredCourseTraceToolchainChecks('P3', 'builtin', 'Default')])
      .toEqual(['Java', 'Logisim']);
    expect([...requiredCourseTraceToolchainChecks('P4', 'auto', 'Default')])
      .toEqual(['ISE fuse']);
    expect([...requiredCourseTraceToolchainChecks('P4', 'mars', 'FixedCompactLargeText')])
      .toEqual(['Java', 'MARS', 'MARS coL2', 'ISE fuse', 'MARS FixedCompactLargeText']);
    expect([...requiredCourseTraceToolchainChecks('P7', 'verify-both', 'CompactLargeText')])
      .toEqual(['Java', 'MARS', 'MARS coL2', 'ISE fuse', 'MARS CompactLargeText', MARS_P7_CHECK]);
  });

  it('formats failed toolchain checks with optional suggestions', () => {
    expect(formatToolchainFailure({ name: 'MARS', ok: false, detail: '未配置' })).toBe('MARS 未配置');
    expect(formatToolchainFailure({ name: 'ISE fuse', ok: false, detail: '不可用', suggestion: '检查 ISE 路径' }))
      .toBe('ISE fuse 不可用（检查 ISE 路径）');
  });

  it('keeps automatic toolchain failures free of local paths and raw details', () => {
    const message = formatAutomaticToolchainFailure({
      name: 'ISE fuse',
      ok: false,
      detail: 'E:/SECRET_ISE_PATH/bin/nt64/fuse.exe',
      suggestion: '检查 ISE 路径'
    });

    expect(message).toBe('ISE fuse 不可用，请检查工具链设置');
    expect(message).not.toContain('SECRET_ISE_PATH');
  });

  it('treats a required capability that was never checked as a failure', () => {
    const failures = requiredToolchainFailures(
      [{ name: 'MARS coL1', ok: true, detail: 'ok' }],
      new Set(['MARS coL1', 'MARS coL2'])
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'MARS coL2', ok: false, detail: '未执行能力检查' });
  });
});
