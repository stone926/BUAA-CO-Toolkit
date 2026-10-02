// @index course-testing — 写回事件对照页：字段差异、首差异上下文和受控导航
import { html, renderReportPage } from './webview/reportLayout';
import { renderResourceTemplate } from './templates/templateRegistry';
import type { WritebackComparison, WritebackEvent, WritebackRow } from './courseTesting/writebackComparison';
import type { FailureEvidence } from './courseTesting/failureEvidence';

export const writebackPageSize = 41;
export interface WritebackComparisonView {
  caseId: string;
  comparison: WritebackComparison;
  focus: number;
  start: number;
  diagnostic?: string;
  message?: string;
  savedDifference?: FailureEvidence;
  sources: ReadonlyMap<string, { line: number; text: string }>;
}

export function renderWritebackComparison(view: WritebackComparisonView): string {
  const { comparison: model } = view;
  const end = Math.min(view.start + writebackPageSize, model.rows.length);
  const rows = model.rows.slice(view.start, end);
  const previous = model.differences.some(index => index < view.focus);
  const next = model.differences.some(index => index > view.focus);
  const current = model.differences.indexOf(view.focus);
  const button = (action: string, label: string, enabled: boolean) => `<button type="button" class="secondary" data-writeback-action="${action}"${enabled ? '' : ' disabled'}>${label}</button>`;
  const empty = !model.oracleEvents || !model.dutEvents;
  const savedOutside = model.truncated && (view.savedDifference?.index ?? -1) >= model.rows.length;
  const summary = empty ? '缺少可比较的写回事件' : model.differences.length ? `${model.differences.length} 项写回差异`
    : model.truncated ? '已显示部分未发现差异' : '普通写回字段一致';
  return renderReportPage({
    title: '写回记录对照',
    subtitle: '按自动测试的写回顺序对照。时间戳、空格、大小写和非写回日志不作为差异。',
    script: 'writeback',
    extraCss: renderResourceTemplate('webview/writeback.css', {}),
    body: html.raw(`
      <div class="writeback-summary"><strong>${html.text(summary)}</strong><span class="muted">参考 ${model.oracleEvents} · CPU ${model.dutEvents} · 用例 ${html.code(view.caseId)}</span></div>
      ${view.diagnostic ? `<p class="saved-diagnostic">测试诊断：${html.text(view.diagnostic.replace(/^\[AUTO-[A-Z-]+\]\s*/, ''))}</p>` : ''}
      ${model.truncated ? '<div class="notice">记录较长，只显示前 200000 项；以上计数为已解析部分，不代表完整比较结果。</div>' : ''}
      ${savedOutside ? `<div class="notice">已保存的首差异位于第 ${view.savedDifference!.index! + 1} 项，超出本页显示范围。可直接定位该差异的原始记录：<div class="actions">${view.savedDifference?.oracle ? button('rawFirstOracle', '首差异 · 参考原文', true) : ''}${view.savedDifference?.dut ? button('rawFirstDut', '首差异 · CPU 原文', true) : ''}</div></div>` : ''}
      ${!model.differences.length && !empty ? '<p class="muted">这里仅比较写回 PC、目标和值。原测试还可能检查 DM 写事务或其他约束，判定以上方测试诊断为准。</p>' : ''}
      <nav class="writeback-toolbar" aria-label="写回差异导航">
        <div>${button('first', '首个差异', model.differences.length > 0)}${button('previous', '↑ 上个差异', previous)}${button('next', '↓ 下个差异', next)}</div>
        <span role="status" aria-live="polite">${current >= 0 ? `差异 ${current + 1} / ${model.differences.length} · ` : ''}${model.rows.length ? `第 ${view.start + 1}–${end} 项 / ${model.rows.length}` : '无写回事件'}</span>
      </nav>
      ${view.message ? `<div class="notice" role="status">${html.text(view.message)}</div>` : ''}
      ${model.rows.length ? `<div class="writeback-table" role="region" aria-label="写回事件对照" tabindex="0"><table>
        <thead><tr><th scope="col">序号 / 状态</th><th scope="col">PC <span class="pc-hint">点击定位汇编</span></th><th scope="col">写入目标</th><th scope="col">参考值</th><th scope="col">CPU 值</th></tr></thead>
        <tbody>${rows.map(row => renderRow(row, view)).join('')}</tbody>
      </table></div>` : '<div class="empty-state">没有可解析的写回事件。请打开原始记录检查输出格式和仿真是否完成。</div>'}
      <nav class="writeback-pagination" aria-label="写回上下文分页">${button('pagePrevious', '前一段', view.start > 0)}${button('pageNext', '后一段', end < model.rows.length)}<span class="muted">保留相邻记录，便于从错误向前追踪。</span></nav>
      <details><summary>原始记录</summary><p class="muted">当前选中第 ${model.rows.length ? view.focus + 1 : '—'} 项。打开原始记录会定位到该项的日志行；缺少对应写回时定位输出末尾。时间和 WARNING 等信息在此保留。</p>
        <div class="actions">${button('rawOracle', '参考原始记录', true)}${button('rawDut', 'CPU 原始输出', true)}</div></details>
    `)
  });
}

function renderRow(row: WritebackRow, view: WritebackComparisonView): string {
  const missing = !row.oracle ? '多出写回' : !row.dut ? '缺少写回' : undefined;
  const labels = { pc: 'PC 不同', target: '目标不同', value: '值不同' };
  const status = missing ?? (row.changedFields.length ? row.changedFields.map(field => labels[field]).join('、') : '一致');
  const changed = row.status !== 'ok';
  const cell = (field: 'pc' | 'target') => {
    const left = row.oracle;
    const right = row.dut;
    const differs = row.changedFields.includes(field);
    if (left && right && !differs) return field === 'pc' ? pc(left, row, 'oracle', view, false) : target(left);
    return `<div class="paired"><span class="side-label">参考</span><span>${left ? field === 'pc' ? pc(left, row, 'oracle', view, differs) : `<span class="${differs ? 'field-change reference' : ''}">${target(left)}</span>` : '—'}</span>
      <span class="side-label">CPU</span><span>${right ? field === 'pc' ? pc(right, row, 'dut', view, differs) : `<span class="${differs ? 'field-change actual' : ''}">${target(right)}</span>` : '—'}</span></div>`;
  };
  return `<tr class="${changed ? 'different' : 'equal'}${row.index === view.focus ? ' selected' : ''}"${row.index === view.focus ? ' data-selected="true" aria-current="true"' : ''}>
    <td><button type="button" class="event-index" data-writeback-action="select" data-row="${row.index}" aria-label="选中第 ${row.index + 1} 项写回">${row.index + 1}</button><span class="row-status">${html.text(status)}</span></td>
    <td>${cell('pc')}</td><td>${cell('target')}</td>
    <td>${value(row.oracle, row.dut, 'reference')}</td><td>${value(row.dut, row.oracle, 'actual')}</td></tr>`;
}

function pc(event: WritebackEvent, row: WritebackRow, side: 'oracle' | 'dut', view: WritebackComparisonView, changed: boolean): string {
  const source = view.sources.get(`${row.index}:${side}`);
  const code = html.text(event.pc.toLowerCase());
  const tone = changed ? ` field-change ${side === 'oracle' ? 'reference' : 'actual'}` : '';
  return source
    ? `<button type="button" class="pc-link${tone}" data-writeback-action="source" data-row="${row.index}" data-side="${side}" title="${html.text(`第 ${source.line} 行：${source.text}`)}" aria-label="定位第 ${row.index + 1} 项${side === 'oracle' ? '参考' : 'CPU'}指令">${code}</button>`
    : `<code class="${tone}">${code}</code>`;
}

function target(event: WritebackEvent): string {
  return String(html.code(event.kind === 'grf' ? `$${event.target}` : `*${event.target.toLowerCase()}`));
}

function value(event: WritebackEvent | undefined, other: WritebackEvent | undefined, tone: 'reference' | 'actual'): string {
  if (!event) return '<span class="missing">无对应写回</span>';
  const text = event.value.toLowerCase();
  const expected = other?.value.toLowerCase();
  const digits = [...text].map((digit, index) => expected && digit !== expected[index]
    ? `<span class="field-change ${tone}">${html.text(digit)}</span>` : String(html.text(digit))).join('');
  return `<code class="write-value">${digits}</code>`;
}
