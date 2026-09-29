import { describe, expect, it } from 'vitest';
import type { HazardReport } from '../hazardAnalysis/reportTypes';
import { renderHazardReport } from '../hazardUi/reportView';

const nonce = 'aValidBase64NonceValue1234';

function reportFixture(): HazardReport {
  return {
    version: 1,
    profile: 'P6', model: 'P6', imageFingerprint: 'abc123',
    summary: {
      instructions: 42, cycles: 51, dataStallCycles: 3, multiplyDivideStallCycles: 0,
      forwardEvents: 10, validForwardEvents: 7, forwardValidRate: 0.7,
      forwardCovered: 8, forwardExpected: 120, forwardCoverage: 8 / 120,
      stallCovered: 2, stallExpected: 20, stallCoverage: 0.1,
      forwardGrade: 62.7, stallGrade: 64
    },
    classCoverage: [{ pair: 'cal_rr <~~ load', consumerClass: 'cal_rr', producerClass: 'load', forwardCovered: 2, forwardExpected: 4, stallCovered: 1, stallExpected: 2, forwardGrade: 80, stallGrade: 80 }],
    forwardTuples: ['lw>add@MD'], stallTuples: ['add<lw#0'],
    events: [
      { kind: 'forward', consumerPc: 0x3004, consumerOrder: 1, cycle: 4, consumer: 'add', producer: 'lw', producerOrder: 0, register: '$t0', role: 'rs', sourceStage: 'M', destinationStage: 'D', valid: true },
      { kind: 'stall', consumerPc: 0x3008, consumerOrder: 2, cycle: 5, consumer: 'beq', producer: 'lw', register: '$t1', interval: 0 }
    ],
    omittedEvents: 0, warnings: [], stopReason: 'course-halt-loop', stopPc: 0x3010
  };
}

describe('native hazard report view', () => {
  it('renders coverage, end state, class matrix, events and actions', () => {
    const page = renderHazardReport(reportFixture(), { inputLabel: 'code.txt', generatedAt: '2026-09-27 10:00' }, nonce);
    expect(page).toContain('冲突冒险报告');
    expect(page).toContain('正常结束');
    expect(page).toContain('6.7%');
    expect(page).toContain('70.0%');
    expect(page).toContain('<progress class="meter" aria-label="转发有效率" value="70" max="100">');
    expect(page).toContain('cal_rr &lt;~~ load');
    expect(page).toContain('0x00003004');
    expect(page).toContain('周期 4');
    expect(page).toContain('寄存器 $t0');
    expect(page).toContain('id="event-search"');
    expect(page).toContain('id="event-reset" hidden');
    expect(page).toContain('class="report-shell hazard-report"');
    expect(page).toContain('class="summary overview"');
    expect(page).toContain('aria-live="polite" aria-atomic="true"');
    expect(page).toContain('reset.addEventListener');
    expect(page).toContain('event.key === \'Escape\'');
    expect(page).toContain('href="#improvements-heading"');
    expect(page).toContain('id="matrix-filter"');
    expect(page).toContain('role="region" aria-label="指令类别覆盖矩阵，可水平滚动" tabindex="0"');
    expect(page).toContain('data-observed="true" data-gap="true"');
    for (const action of ['reanalyze', 'openInput', 'openJson']) {
      expect(page).toContain(`data-action="${action}"`);
    }
    expect(page).toContain('acquireVsCodeApi()');
    expect(page).toContain('filterEvents()');
    expect(page).not.toContain('command:');
  });

  it('escapes every external text position and uses a restrictive nonce CSP', () => {
    const malicious = '</script><img src=x onerror=alert(1)>"&';
    const report = reportFixture();
    const page = renderHazardReport({
      ...report,
      classCoverage: [{ ...report.classCoverage[0], pair: malicious }],
      events: [{ ...report.events[0], consumer: malicious, producer: malicious, register: malicious }],
      warnings: [malicious]
    }, { inputLabel: malicious, generatedAt: malicious }, nonce);
    expect(page).not.toContain(malicious);
    expect(page).not.toContain('<img src=x');
    expect(page).toContain('&lt;/script&gt;&lt;img src=x onerror=alert(1)&gt;&quot;&amp;');
    expect(page).toContain(`script-src 'nonce-${nonce}'`);
    expect(page).toContain(`style-src 'nonce-${nonce}'`);
    expect(page).not.toContain('unsafe-inline');
    expect(page).not.toContain('style=');
    expect(page).not.toContain('http://');
    expect(page).not.toContain('https://');
  });

  it('rejects nonce values that could escape HTML attributes or CSP', () => {
    expect(() => renderHazardReport(reportFixture(), { inputLabel: 'code.txt' }, `bad" onload="alert(1)`)).toThrow('Invalid Webview CSP nonce');
  });

  it('explains a partial report and handles no events or target rows', () => {
    const report = reportFixture();
    const page = renderHazardReport({
      ...report,
      stopReason: 'step-limit',
      classCoverage: [], events: [], omittedEvents: 0,
      summary: { ...report.summary, forwardValidRate: null }
    }, { inputLabel: 'code.txt' }, nonce);
    expect(page).toContain('达到步数上限');
    expect(page).toContain('这次执行尚未记录冒险事件');
    expect(page).toContain('当前模型没有可展示的分类覆盖数据');
  });
});
