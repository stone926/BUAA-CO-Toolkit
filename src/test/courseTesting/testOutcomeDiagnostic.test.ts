import { describe, expect, it } from 'vitest';
import type { CourseTraceCaseResult } from '../../courseTestReport';
import { specialTimerExlNotice } from '../../courseTesting/p7ProbeScope';
import {
  baseAutomaticDiagnosticMessage,
  neutralCourseTraceStage,
  publicAutomaticDiagnosticMessage
} from '../../courseTesting/testOutcomeDiagnostic';

const result = (overrides: Partial<CourseTraceCaseResult>): CourseTraceCaseResult => ({
  asm: 'hidden.asm', status: 'failed', stage: 'probe', message: 'E:/PRIVATE/internal failure',
  ...overrides
});

describe('public automatic outcome diagnosis', () => {
  it('retains the first probe failure with its scenario and Chinese kind', () => {
    const message = publicAutomaticDiagnosticMessage(result({
      probe: {
        passed: false, records: [], diagnostics: [],
        failures: [
          { scenarioId: 7, kind: 'timer0', message: '计时器清除后的 COUNT 不符：应为 0，实际为 0x15' },
          { scenarioId: 8, kind: 'timer1', message: '第二个失败' }
        ]
      }
    }));
    expect(message).toBe('[AUTO-PROBE] 场景 7 定时器 0：计时器清除后的 COUNT 不符：应为 0，实际为 0x15');
    expect(message).not.toContain('第二个失败');
    expect(message).not.toContain('PRIVATE');
  });

  it('translates legacy probe failure text and strips machine paths and controls', () => {
    expect(publicAutomaticDiagnosticMessage(result({
      probe: {
        passed: false, records: [], diagnostics: [],
        failures: [{ scenarioId: 0, kind: 'cp0-reset',
          message: 'CP0 reset status read-back differs: expected exactly one zero sample at PC 0x300c' }]
      }
    }))).toContain('CP0 复位后 Status 读回值不符合预期：PC 0x300c 应恰好记录一次零值样本');

    const message = publicAutomaticDiagnosticMessage(result({
      probe: {
        passed: false, records: [], diagnostics: [],
        failures: [{ scenarioId: 1, kind: 'tb',
          message: `错误\u001b[31m：E:/PRIVATE/source.v ${'内'.repeat(600)}` }]
      }
    }));
    expect(message).toContain('场景 1 测试平台接口：错误');
    expect(message).toContain('<path>');
    expect(message).not.toContain('PRIVATE');
    expect(message).not.toContain('\u001b');
    expect(message.length).toBeLessThanOrEqual(340);
    for (const location of ['//server/课程/CPU.v', 'file://server/课程/CPU.v']) {
      const networkPath = publicAutomaticDiagnosticMessage(result({
        probe: { passed: false, records: [], diagnostics: [], failures: [
          { scenarioId: 1, kind: 'tb', message: `错误：${location}` }
        ] }
      }));
      expect(networkPath).toContain('<path>');
      expect(networkPath).not.toContain('server');
      expect(networkPath).not.toContain('CPU.v');
    }
  });

  it('summarizes the structured first difference with exact PC and writes', () => {
    const message = publicAutomaticDiagnosticMessage(result({
      stage: 'compare',
      firstDiff: {
        index: 2, status: 'diff', reason: 'Write value differs.',
        mars: { pc: '0000300C', kind: 'grf', target: '2', value: '0000002A', raw: 'private', lineNumber: 3 },
        sim: { pc: '00003010', kind: 'grf', target: '2', value: '0000002B', raw: 'private', lineNumber: 4 }
      }
    }));
    expect(message).toBe(
      '[AUTO-MISMATCH] 写入值不一致。 参考结果 PC 0000300C，$2 <= 0000002A；待测 CPU PC 00003010，$2 <= 0000002B'
    );
    expect(message).not.toContain('private');
  });

  it('uses a missing-event explanation and refuses arbitrary snapshot or reason text', () => {
    const message = publicAutomaticDiagnosticMessage(result({
      stage: 'compare',
      firstDiff: {
        index: 1, status: 'oracle-only', reason: 'E:/PRIVATE/reason',
        oracle: { pc: '00003004', kind: 'dm', target: '00000010', value: '000000FE', raw: 'secret', lineNumber: 2 },
        dut: { pc: 'E:/PRIVATE', kind: 'grf', target: '1', value: '0', raw: 'secret', lineNumber: 3 }
      }
    }));
    expect(message).toContain('待测 CPU 缺少一条参考结果中的写回事件');
    expect(message).toContain('PC 00003004，*00000010 <= 000000FE');
    expect(message).toContain('（事件格式无效）');
    expect(message).not.toContain('PRIVATE');
    expect(message).not.toContain('secret');
  });

  it('retains exact structured DM transaction differences without event snapshots', () => {
    const message = publicAutomaticDiagnosticMessage(result({
      stage: 'compare',
      firstDiff: {
        index: 5, status: 'diff',
        reason: 'DM 写事务 #6 (PC=0x00003024)：目标字地址应为 0x00000010，实际地址为 0x00000014'
      }
    }));
    expect(message).toBe(
      '[AUTO-MISMATCH] DM 写事务 #6 (PC=0x00003024)：目标字地址应为 0x00000010，实际地址为 0x00000014'
    );
    expect(publicAutomaticDiagnosticMessage(result({
      stage: 'compare',
      firstDiff: { index: 5, status: 'diff',
        reason: 'DM 写事务 #6 (PC=0x00003024)：字节使能应为 0011，实际为 1100' }
    }))).toContain('字节使能应为 0011，实际为 1100');
  });

  it('keeps state precedence, generic fallbacks, and the special scope notice once', () => {
    const probe = {
      passed: false, records: [], diagnostics: [], failures: [],
      coverage: [{ covered: false, message: 'window missing' }]
    };
    expect(publicAutomaticDiagnosticMessage(result({ status: 'error', probe })))
      .toBe('[AUTO-COVERAGE] 未覆盖：返回后中断触发窗口未观测，无法判定');
    expect(publicAutomaticDiagnosticMessage(result({ status: 'failed', probe })))
      .toBe('[AUTO-PROBE] P7 定向检查未通过');
    expect(publicAutomaticDiagnosticMessage(result({ status: 'passed', probe }))).toBe('通过');
    expect(publicAutomaticDiagnosticMessage(result({ status: 'failed', cancelled: true, probe })))
      .toBe('[AUTO-STOPPED] 测试已停止');
    const special = publicAutomaticDiagnosticMessage(result({ probeScope: 'special-timer-exl' }));
    expect(special.split(specialTimerExlNotice)).toHaveLength(2);
    expect(baseAutomaticDiagnosticMessage(result({ probeScope: 'special-timer-exl' })))
      .not.toContain(specialTimerExlNotice);
    expect(neutralCourseTraceStage('mars')).toBe('oracle');
    expect(neutralCourseTraceStage('logisim')).toBe('dut');
  });

  it('keeps the structured simulator diagnosis for tool errors', () => {
    const message = publicAutomaticDiagnosticMessage(result({
      status: 'error', stage: 'dut', dutBackend: 'iverilog',
      dutFailure: {
        phase: 'compile', reason: 'exit', exitCode: 26,
        diagnostic: { file: 'E:/PRIVATE/CPU.v', line: 9, message: 'unable to bind' }
      }
    }));
    expect(message).toBe('[AUTO-DUT] Icarus 编译失败（退出码 26）：CPU.v:9: unable to bind');
    expect(message).not.toContain('PRIVATE');
  });
});
