import { describe, expect, it } from 'vitest';
import { courseTraceMemoryConfigurationError, formatToolchainFailure } from '../courseTestToolchain';

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

  it('formats failed toolchain checks with optional suggestions', () => {
    expect(formatToolchainFailure({ name: 'MARS', ok: false, detail: '未配置' })).toBe('MARS 未配置');
    expect(formatToolchainFailure({ name: 'ISE fuse', ok: false, detail: '不可用', suggestion: '检查 ISE 路径' }))
      .toBe('ISE fuse 不可用（检查 ISE 路径）');
  });
});
