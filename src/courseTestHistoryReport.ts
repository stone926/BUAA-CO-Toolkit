// @index course-testing — 测试历史的结果、未执行状态与特殊场景说明
import type { AsmCaseManifestEntry } from './courseTestReport';
import { isManifestV2, manifestSourceOf, manifestP7Of } from './courseTesting/manifestCodec';
import { probeScopeFromCase, specialTimerExlNotice } from './courseTesting/p7ProbeScope';
import { html, renderBadge, renderMetricGrid, renderReportPage, renderTable, type SafeHtml } from './webview/reportLayout';

const escapeHtml = html.text;
function statusTone(status: string | undefined): 'ok' | 'bad' | 'warn' | 'neutral' {
  return status === 'passed' ? 'ok' : status === 'failed' ? 'bad' : status === 'error' ? 'warn' : 'neutral';
}

export function renderAsmCaseIndex(cases: AsmCaseManifestEntry[]): string {
  const rows = cases.map(({ manifest }) => {
    const automatic = manifestSourceOf(manifest).kind !== 'selected';
    const metadata = isManifestV2(manifest) ? manifest.metadata : undefined;
    const recordedStatus = metadata?.['test.status'];
    const state = metadata?.['rerun.state'] ?? metadata?.['continuous.state'];
    const outcome = recordedStatus ?? (state === 'passed' || state === 'failed' || state === 'error' ? state : undefined);
    const diagnostic = metadata?.['test.diagnostic'];
    const uncovered = outcome === 'error' && diagnostic?.startsWith('[AUTO-COVERAGE]');
    const scope = probeScopeFromCase(manifestP7Of(manifest)?.probe, metadata);
    const scopeNotice = scope === 'special-timer-exl'
      ? html.raw(`<div class="notice">${html.text(specialTimerExlNotice)}</div>`)
      : html.raw('');
    const conciseDiagnostic = scope === 'special-timer-exl' && diagnostic?.endsWith(specialTimerExlNotice)
      ? diagnostic.slice(0, -specialTimerExlNotice.length).replace(/。$/, '') : diagnostic;
    const hasOutcome = outcome === 'passed' || outcome === 'failed' || outcome === 'error';
    const pendingLabel = state === 'cancelled' ? '已取消' : '无结果';
    const fallbackDiagnostic = hasOutcome
      ? outcome === 'passed' ? '通过' : '已记录测试结果，但未保存具体诊断。'
      : state === 'cancelled' ? '测试已取消，未形成通过或失败判定。'
        : state === 'generated' ? '测试点已生成，但尚未记录判定结果；可能尚未执行或测试提前停止。'
          : '未保存测试结果，无法判定是否通过。';
    return {
      className: hasOutcome ? outcome : 'saved',
      cells: [
        renderBadge(outcome === 'passed' ? '通过' : outcome === 'failed' ? '失败' : uncovered ? '未覆盖'
          : outcome === 'error' ? '错误' : pendingLabel, statusTone(outcome)),
        html.raw(`${html.code(manifest.caseId)}<div class="actions"><button type="button" class="secondary" data-report-action="inspectCase" data-case-id="${html.text(manifest.caseId)}">${outcome === 'failed' || outcome === 'error' ? '定位失败' : '查看用例'}</button></div>`),
        html.raw(`${html.text(conciseDiagnostic || fallbackDiagnostic)}${scopeNotice}`),
        escapeHtml(manifest.profile),
        escapeHtml(automatic ? '自动测试' : '手动测试'),
        renderCreatedAt(manifest.createdAt)
      ]
    };
  });
  return renderReportPage({
    title: '测试历史 / 失败用例',
    subtitle: '按创建时间倒序排列，测试结果自动更新。点击“定位失败”查看证据、定位汇编或重跑用例。',
    extraCss: `
      table { table-layout: fixed; min-width: 800px; }
      th:nth-child(1) { width: 78px; }
      th:nth-child(2) { width: 170px; }
      th:nth-child(4) { width: 80px; }
      th:nth-child(5) { width: 84px; }
      th:nth-child(6) { width: 108px; }
      td:nth-child(4), td:nth-child(5) { white-space: nowrap; }
      td:last-child { color: var(--co-muted); font-size: 12px; }
      .timestamp span { display: block; }
    `,
    script: cases.length > 0 ? 'history' : undefined,
    body: html.raw(`
  ${renderMetricGrid([
    { label: '已保存测试点', value: cases.length },
    { label: '通过', value: rows.filter((row) => row.className === 'passed').length, tone: 'ok' },
    { label: '失败 / 错误', value: rows.filter((row) => row.className === 'failed' || row.className === 'error').length, tone: 'bad' }
  ])}
  ${cases.length ? `<div class="filters" data-report-filters role="search" aria-label="筛选测试历史">
    <label class="search-field">搜索记录<input type="search" placeholder="复现编号、课程阶段或诊断关键词" aria-controls="history-results"></label>
    <label>测试结果<select aria-controls="history-results">
      <option value="">全部结果</option><option value="problem">失败 / 错误</option>
      <option value="passed">通过</option><option value="failed">失败</option><option value="error">错误</option><option value="saved">无判定结果</option>
    </select></label>
    <button type="button" class="secondary">清除筛选</button>
  </div>
  <p class="filter-count" id="filter-count" role="status" aria-live="polite">共 ${cases.length} 个测试点</p>
  <div class="empty-state" id="filter-empty" hidden><strong>没有匹配的记录</strong><p>试试其他关键词，或清除筛选查看全部测试点。</p></div>` : ''}
  <section id="history-results" aria-label="测试历史">
  ${renderTable(['结果', '复现编号', '诊断', '阶段', '来源', '时间'], rows, {
    label: '测试历史', emptyMessage: '还没有测试记录。使用侧边栏的“启动持续测试”开始检查 CPU。'
  })}
  </section>
`)
  });
}

let createdAtFormatter: Intl.DateTimeFormat | undefined;

function renderCreatedAt(value: string): SafeHtml {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return html.text(value);
  createdAtFormatter ??= new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const parts = createdAtFormatter.formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  const day = `${part('year')}/${part('month')}/${part('day')}`;
  const time = `${part('hour')}:${part('minute')}:${part('second')}`;
  return html.raw(`<time class="timestamp" datetime="${html.text(value)}" title="${html.text(value)}"><span>${html.text(day)}</span><span>${html.text(time)}</span></time>`);
}
