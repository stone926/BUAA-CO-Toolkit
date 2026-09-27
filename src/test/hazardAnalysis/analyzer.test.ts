import { describe, expect, it } from 'vitest';
import { analyzeHazardProgram } from '../../hazardAnalysis/analyzer';
import { HazardMachineCodeError, parseHazardMachineCode } from '../../hazardAnalysis/machineCode';
import { buildProgramImage } from '../../mips/core/programImage';

function image(words: readonly number[]) {
  return parseHazardMachineCode(words.map((word) => word.toString(16).padStart(8, '0')).join('\n'), 'P5');
}

describe('内置冒险分析', () => {
  it('按动态跳转和延迟槽分析，排除跳过的指令', async () => {
    const program = image([
      0x34010001, // ori $1,$0,1
      0x10210002, // beq $1,$1,+2
      0x34020005, // delay slot: ori $2,$0,5
      0x34020009, // skipped
      0x00411820  // add $3,$2,$1
    ]);
    const report = await analyzeHazardProgram(program, { profile: 'P5' });
    expect(report.stopReason).toBe('program-end');
    expect(report.summary.instructions).toBe(4);
    expect(report.events.some((event) => event.consumerPc === 0x300c)).toBe(false);
    expect(report.events.some((event) => event.kind === 'forward')).toBe(true);
  });

  it('统计 load-use 阻塞和有效转发，并限制保留事件数', async () => {
    const report = await analyzeHazardProgram(image([
      0x34010004, // ori $1,$0,4
      0xac010000, // sw $1,0($0)
      0x8c020000, // lw $2,0($0)
      0x00411820  // add $3,$2,$1
    ]), { profile: 'P5', maxEvents: 1 });
    expect(report.stopReason).toBe('program-end');
    expect(report.summary.dataStallCycles).toBeGreaterThan(0);
    expect(report.summary.validForwardEvents).toBeGreaterThan(0);
    expect(report.events).toHaveLength(1);
    expect(report.omittedEvents).toBeGreaterThan(0);
    expect(report.summary.forwardCovered).toBeGreaterThan(0);
    expect(report.forwardTuples).toEqual([
      'lw>add@WE', 'ori>add@WD', 'ori>sw@ME'
    ]);
    expect(report.stallTuples).toEqual(['add<lw#0']);
  });

  it('零寄存器目的寄存器不会冒充有效 GPR 转发', async () => {
    const report = await analyzeHazardProgram(image([
      0x34000007, // ori $0,$0,7
      0x34010001  // ori $1,$0,1
    ]), { profile: 'P5' });
    expect(report.stopReason).toBe('program-end');
    expect(report.summary.forwardEvents).toBe(0);
    expect(report.events.some((event) => event.kind === 'zero' && event.valid)).toBe(true);
  });

  it('旧值与新值相同时保留转发事件但不增加有效覆盖', async () => {
    const report = await analyzeHazardProgram(image([
      0x34010000, // ori $1,$0,0
      0x34220001  // ori $2,$1,1
    ]), { profile: 'P5' });
    expect(report.summary.forwardEvents).toBeGreaterThan(0);
    expect(report.summary.validForwardEvents).toBe(0);
    expect(report.summary.forwardCovered).toBe(0);
    expect(report.summary.forwardValidRate).toBe(0);
    expect(report.events.some((event) => event.kind === 'forward' && event.valid === false)).toBe(true);
  });

  it('分支在 D 级等待 ALU 结果：与课程计算器的 E 阻塞和 M→D 转发一致', async () => {
    const report = await analyzeHazardProgram(image([
      0x34010001, 0x10200001, 0x00000000, 0x34020001
    ]), { profile: 'P5' });
    expect(report.stallTuples).toContain('beq<ori#0');
    expect(report.forwardTuples).toContain('ori>beq@MD');
  });

  it('接受带初始数据段的 ProgramImage，按实际载入值判断有效性', async () => {
    const program = buildProgramImage({
      entryPc: 0x3000,
      segments: [
        { name: 'text', baseAddress: 0x3000, words: [0x8c010000, 0x00211020] }, // lw $1,0($0); add $2,$1,$1
        { name: 'data', baseAddress: 0, words: [7] }
      ], inputGraph: []
    });
    const report = await analyzeHazardProgram(program, { profile: 'P5' });
    expect(report.stopReason).toBe('program-end');
    expect(report.summary.validForwardEvents).toBeGreaterThan(0);
    expect(report.summary.dataStallCycles).toBeGreaterThan(0);
  });

  it('复用核心求值识别 HI/LO、移位和载入写入 $0 的原始非零值', async () => {
    const program = buildProgramImage({
      entryPc: 0x3000,
      segments: [
        { name: 'text', baseAddress: 0x3000, words: [
          0x34010006, 0x34020003, 0x00220018, // ori, ori, mult
          0x00000012, 0x34030001,             // mflo $0; ori $3,$0,1
          0x00010080, 0x34030001,             // sll $0,$1,2; ori $3,$0,1
          0x8c000000, 0x34030001              // lw $0,0($0); ori $3,$0,1
        ] },
        { name: 'data', baseAddress: 0, words: [7] }
      ], inputGraph: []
    });
    const report = await analyzeHazardProgram(program, { profile: 'P6' });
    expect(report.stopReason).toBe('program-end');
    for (const producer of ['mflo', 'sll', 'lw']) {
      expect(report.events.some((event) => event.kind === 'zero' && event.producer === producer && event.valid)).toBe(true);
    }
  });

  it('乘除单元忙会产生独立等待而不计入课程数据阻塞', async () => {
    const report = await analyzeHazardProgram(image([
      0x20010006, 0x20020003,
      0x00220018, // mult $1,$2
      0x00001812, // mflo $3
      0x00220018  // mult $1,$2
    ]), { profile: 'P6' });
    expect(report.stopReason).toBe('program-end');
    expect(report.summary.multiplyDivideStallCycles).toBe(4);
    expect(report.summary.forwardEvents).toBe(2);
    expect(report.summary.validForwardEvents).toBe(2);
  });

  it('P7 正常程序沿用 P6 评分模型', async () => {
    const report = await analyzeHazardProgram(image([0x34010001, 0x34220001]), { profile: 'P7' });
    expect(report.stopReason).toBe('program-end');
    expect(report.model).toBe('P6');
    expect(report.summary.instructions).toBe(2);
  });

  it('P7 异常清空流水线，不把受害 syscall 或跨 handler 的值算作转发', async () => {
    const program = buildProgramImage({
      entryPc: 0x3000,
      segments: [
        { name: 'text', baseAddress: 0x3000, words: [0x34010007, 0x0000000c] },
        { name: 'ktext', baseAddress: 0x4180, words: [0x34220001, 0x1000ffff, 0] }
      ], inputGraph: []
    });
    const report = await analyzeHazardProgram(program, { profile: 'P7' });
    expect(report.stopReason).toBe('course-halt-loop');
    expect(report.summary.instructions).toBe(4);
    expect(report.events.some((event) => event.producerPc === 0x3000 && event.consumerPc === 0x4180)).toBe(false);
    expect(report.warnings.some((warning) => warning.includes('异常'))).toBe(true);
  });

  it('P7 Timer 缺少设备周期表时明确终止为域外', async () => {
    const report = await analyzeHazardProgram(image([0x34017f00, 0x8c220000]), { profile: 'P7' });
    expect(report.stopReason).toBe('out-of-domain');
    expect(report.warnings.some((warning) => warning.includes('device-schedule-missing'))).toBe(true);
  });

  it('取消、步数上限都返回可序列化的部分报告', async () => {
    const program = image([0x34010001, 0x34210001, 0x34210001]);
    const signal = { aborted: false };
    const cancelled = await analyzeHazardProgram(program, {
      profile: 'P5', sliceSize: 1, signal,
      yieldControl: async () => { signal.aborted = true; }
    });
    expect(cancelled.stopReason).toBe('cancelled');
    expect(cancelled.summary.instructions).toBe(1);
    expect(JSON.parse(JSON.stringify(cancelled)).stopReason).toBe('cancelled');
    const limited = await analyzeHazardProgram(program, { profile: 'P5', maxSteps: 1 });
    expect(limited.stopReason).toBe('step-limit');
  });
});

describe('机器码文本解析', () => {
  it('读取纯十六进制、Logisim v2 raw 压缩行与 COE', () => {
    expect(parseHazardMachineCode('20010001\n00000000', 'P5').segments[0].words).toEqual([0x20010001, 0]);
    expect(parseHazardMachineCode('v2.0 raw\n20010001 2*00000000', 'P5').segments[0].words).toEqual([0x20010001, 0, 0]);
    expect(parseHazardMachineCode('memory_initialization_radix=16;\nmemory_initialization_vector=\n20010001,\n00000000;', 'P5').segments[0].words).toEqual([0x20010001, 0]);
  });

  it('按原始行号报告输入错误及大小上限', () => {
    expect(() => parseHazardMachineCode('20010001\nnot-a-word', 'P5')).toThrowError(HazardMachineCodeError);
    expect(() => parseHazardMachineCode('20010001\nnot-a-word', 'P5')).toThrow('第 2 行');
    expect(() => parseHazardMachineCode('v2.0 raw\n4097*00000000', 'P5')).toThrow('第 2 行');
    expect(() => parseHazardMachineCode('memory_initialization_radix=16;\nmemory_initialization_vector=\nzz;', 'P5')).toThrow('第 3 行');
  });
});
