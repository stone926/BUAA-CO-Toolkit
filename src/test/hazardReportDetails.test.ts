import { describe, expect, it } from 'vitest';
import { analyzeHazardProgram } from '../hazardAnalysis/analyzer';
import { assembleCourseSource } from '../mips/core/assembler/assembler';
import { isHazardReport } from '../hazardUi/reportValidation';
import { renderHazardReport } from '../hazardUi/reportView';

const nonce = 'aValidBase64NonceValue1234';
async function report() {
  const image = assembleCourseSource({ id: 'detail-view', text: '.text\nori $1,$0,1\nori $1,$0,2\nori $2,$1,0xffff\nori $0,$0,9\nadd $3,$0,$0\nend: beq $0,$0,end\nnop' }, { profile: 'P5' }).image!;
  return analyzeHazardProgram(image, { profile: 'P5', maxEvents: 0, yieldControl: async () => undefined });
}

describe('detailed hazard report presentation and compatibility', () => {
  it('renders full counts and masked effects even when no event examples were retained', async () => {
    const value = await report();
    expect(isHazardReport(value)).toBe(true);
    const html = renderHazardReport(value, { inputLabel: 'case.asm' }, nonce);
    expect(value.events).toEqual([]);
    expect(value.detailed!.zero.events).toBeGreaterThan(0);
    expect(value.detailed!.forward.observability.masked).toBeGreaterThan(0);
    for (const text of ['端口与优先级细分', '$0 丢弃写', '多写入者优先级', '效果不变', '同时阻塞原因', '本报告未保留事件实例', '不等于整个程序的故障检出率']) expect(html).toContain(text);
    expect(html).not.toContain('只有能改变消费者结果的转发');
    expect(html).not.toContain('这次执行尚未记录冒险事件');
  });

  it('opens historical v1 reports without pretending missing details are zeros', async () => {
    const { detailed: _details, execution: _execution, ...legacy } = await report();
    expect(isHazardReport(legacy)).toBe(true);
    const html = renderHazardReport(legacy, { inputLabel: 'old.asm' }, nonce);
    expect(html).toContain('旧版报告未采集');
    expect(html).toContain('旧版报告未记录外部中断上下文');
  });

  it('validates complete detailed counters, bounded keys, and IRQ records', async () => {
    const value = await report();
    const detailed = value.detailed!;
    expect(isHazardReport({ ...value, detailed: { ...detailed, forward: { ...detailed.forward, events: -1 } } })).toBe(false);
    expect(isHazardReport({ ...value, detailed: { ...detailed, forward: { ...detailed.forward, observability: { observable: 0, masked: 0, unknown: 0 } } } })).toBe(false);
    expect(isHazardReport({ ...value, detailed: { ...detailed, forward: { ...detailed.forward, keys: Array(2049).fill('x') } } })).toBe(false);
    expect(isHazardReport({ ...value, execution: { source: 'case', caseId: 'x', externalInterrupts: [{ victimPc: 0x3001, occurrence: 1 }] } })).toBe(false);
    expect(isHazardReport({ ...value, execution: { source: 'case', caseId: 'x', externalInterrupts: [{ victimPc: 0x3004, occurrence: 0 }] } })).toBe(false);
  });

  it('marks incomplete key lists and escapes new textual fields', async () => {
    const value = await report();
    const malicious = '<img src=x onerror=alert(1)>';
    const html = renderHazardReport({ ...value,
      execution: { source: 'case', caseId: malicious, externalInterrupts: [{ victimPc: 0x300c, occurrence: 1 }] },
      detailed: { ...value.detailed!, priority: { ...value.detailed!.priority, keys: [malicious], keysTruncated: true } },
      events: [{ kind: 'priority', consumer: 'add', consumerPc: 0x3008, consumerOrder: 2, cycle: 4,
        olderProducer: malicious, newerProducer: 'lw', olderGap: 0, newerGap: 1, observability: 'observable' }]
    }, { inputLabel: 'test' }, nonce);
    expect(html).not.toContain(malicious);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('组合清单达到保留上限');
    expect(html).toContain('0x0000300c');
    expect(html).toContain('替换旧值后当前指令效果改变');
  });
});
