import { describe, expect, it } from 'vitest';
import {
  courseInstructionAddressCapability,
  courseTraceMemoryConfigurationError,
  formatToolchainFailure,
  p7CourseContractCapability,
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

  it('formats failed toolchain checks with optional suggestions', () => {
    expect(formatToolchainFailure({ name: 'MARS', ok: false, detail: '未配置' })).toBe('MARS 未配置');
    expect(formatToolchainFailure({ name: 'ISE fuse', ok: false, detail: '不可用', suggestion: '检查 ISE 路径' }))
      .toBe('ISE fuse 不可用（检查 ISE 路径）');
  });

  it('treats a required capability that was never checked as a failure', () => {
    const failures = requiredToolchainFailures(
      [{ name: 'MARS coL1', ok: true, detail: 'ok' }],
      new Set(['MARS coL1', 'MARS coL2'])
    );

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ name: 'MARS coL2', ok: false, detail: '未执行能力检查' });
  });

  it('accepts only an explicit course instruction-address rejection for the ktext detour probe', () => {
    expect(courseInstructionAddressCapability({
      ok: false,
      stdout: '',
      stderr: 'Runtime exception: Course instruction address out of range at 0x00004000'
    }).ok).toBe(true);

    expect(courseInstructionAddressCapability({
      ok: true,
      stdout: 'Program reached course halt loop at 0x00003010.',
      stderr: ''
    }).ok).toBe(false);
    expect(courseInstructionAddressCapability({
      ok: false,
      stdout: '',
      stderr: 'Error: assembler failed for an unrelated reason'
    }).ok).toBe(false);
  });

  it('requires the P7 oracle to replace MARS-only padding statements with loaded NOPs', () => {
    const escape = {
      ok: false,
      stdout: '',
      stderr: 'Course instruction address not loaded at 0x00005000'
    };
    expect(courseInstructionAddressCapability(escape, {
      ok: true,
      stdout: '@00004194: $ 5 <= 0000600D\nProgram reached course halt loop at 0x00003010.',
      stderr: ''
    }).ok).toBe(true);
    expect(courseInstructionAddressCapability(escape, {
      ok: true,
      stdout: '@0000417c: $ 4 <= 00000001\n@00004188: $ 5 <= 00000BAD\nProgram reached course halt loop at 0x00003010.',
      stderr: ''
    }).ok).toBe(false);
  });

  it('accepts only explicit failures for every tutorial P7 test-data contract probe', () => {
    const rejected = (reason: string) => ({
      ok: false,
      stdout: '',
      stderr: `Course P7 test contract violation: ${reason}`
    });
    const acceptedPending = {
      ok: true,
      stdout: '@00004184: $ 7 <= 0000600d\nProgram reached course halt loop at 0x00003010.',
      stderr: ''
    };
    expect(p7CourseContractCapability(
      rejected('interrupt-generator access from user text'),
      rejected('interrupt-generator access has invalid instruction'),
      rejected('handler raised a synchronous exception'),
      rejected('new HWInt bit rose in handler'),
      acceptedPending
    ).ok).toBe(true);

    expect(p7CourseContractCapability(
      rejected('interrupt-generator access from user text'),
      rejected('interrupt-generator access has invalid instruction'),
      { ok: false, stdout: '', stderr: 'Runtime exception at 0x00004180' },
      rejected('new HWInt bit rose in handler'),
      acceptedPending
    ).ok).toBe(false);
    expect(p7CourseContractCapability(
      rejected('interrupt-generator access from user text'),
      rejected('interrupt-generator access has invalid instruction'),
      rejected('handler raised a synchronous exception'),
      {
        ok: true,
        stdout: 'Program reached course halt loop at 0x00003004.',
        stderr: ''
      },
      acceptedPending
    ).ok).toBe(false);
    expect(p7CourseContractCapability(
      rejected('interrupt-generator access from user text'),
      { ok: true, stdout: 'Program reached course halt loop at 0x00003010.', stderr: '' },
      rejected('handler raised a synchronous exception'),
      rejected('new HWInt bit rose in handler'),
      acceptedPending
    ).ok).toBe(false);
    expect(p7CourseContractCapability(
      rejected('interrupt-generator access from user text'),
      rejected('interrupt-generator access has invalid instruction'),
      rejected('handler raised a synchronous exception'),
      rejected('new HWInt bit rose in handler'),
      rejected('new HWInt bit incorrectly rejected at handler entry')
    ).ok).toBe(false);
  });
});
