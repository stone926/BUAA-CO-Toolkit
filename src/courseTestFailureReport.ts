// @index course-testing — 失败排查页纯渲染：首差异、源码入口、重跑状态与渐进详情
import type { FailureEvidence } from './courseTesting/failureEvidence';
import { failureNextStep, type RecordedTestStatus } from './courseTesting/failureDiagnosis';
import { html, renderBadge, renderReportPage, renderTable } from './webview/reportLayout';

export interface CourseFailureView {
  caseId: string;
  profile: string;
  status: RecordedTestStatus;
  diagnostic: string;
  evidence?: FailureEvidence;
  scopeNotice?: string;
  targets: Array<{ label: string; pc: number; line?: number; text?: string }>;
  sourceAvailable: boolean;
  compareAvailable: boolean;
  dutAvailable: boolean;
  logs: string[];
  canRerun: boolean;
  canWaveform: boolean;
  canHazard: boolean;
  warnings: string[];
  busy?: boolean;
  actionMessage?: string;
  previousCaseId?: string;
  waveformAvailable?: boolean;
  canJoinEditors?: boolean;
}

export function renderCourseTestFailure(view: CourseFailureView): string {
  const uncovered = view.status === 'error' && view.diagnostic.startsWith('[AUTO-COVERAGE]');
  const label = view.status === 'passed' ? '通过' : view.status === 'failed' ? '结果不符'
    : uncovered ? '未覆盖' : view.status === 'error' ? '测试未完成' : view.status === 'cancelled' ? '已取消' : '无结果';
  const tone = view.status === 'passed' ? 'ok' : view.status === 'failed' ? 'bad' : 'warn';
  const button = (action: string, text: string, available = true, index?: number, primary = false) =>
    `<button type="button"${primary ? '' : ' class="secondary"'} data-failure-action="${action}"${index === undefined ? '' : ` data-index="${index}"`}${!available || view.busy ? ' disabled' : ''}>${html.text(text)}</button>`;
  const evidence = view.evidence;
  const summary = (view.scopeNotice && view.diagnostic.endsWith(view.scopeNotice)
    ? view.diagnostic.slice(0, -view.scopeNotice.length) : view.diagnostic).replace(/^\[AUTO-[A-Z-]+\]\s*/, '');
  const targets = view.targets.map((target, index) => `<div class="source-card">
    <div><strong>${html.text(target.label)}</strong> ${html.code(`0x${target.pc.toString(16).padStart(8, '0')}`)}
    ${target.line ? `<span class="muted">第 ${target.line} 行</span>` : '<span class="muted">没有可用源码映射</span>'}</div>
    ${target.text ? `<pre>${html.text(target.text)}</pre>` : ''}
    ${target.line ? button('source', `定位${target.label}`, true, index) : ''}</div>`).join('');
  const eventRows = ([['参考结果', evidence?.oracle], ['待测 CPU', evidence?.dut]] as const).map(([role, event]) => ({
    cells: [role, event ? html.code(event.pc) : '无对应事件', event ? html.code(event.kind === 'grf' ? `$${event.target}` : `*${event.target}`) : '—', event ? html.code(event.value) : '—']
  }));
  return renderReportPage({
    title: view.previousCaseId ? '用例重跑结果' : '用例排查',
    subtitle: '查看失败证据，修改 CPU 后重跑同一程序。',
    script: 'failure',
    extraCss: 'table { min-width: 420px; } .source-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 12px; } .source-card { border: 1px solid var(--co-border); border-radius: 6px; padding: 14px; min-width: 0; } details { margin-top: 24px; } summary { cursor: pointer; } .diagnosis { font-size: 14px; }',
    actions: html.raw(`${button('rerun', view.busy ? '正在重跑…' : '重跑此用例', view.canRerun, undefined, true)}
      ${view.waveformAvailable ? button('openWaveform', '打开本次波形') : ''}
      ${view.canWaveform ? button('waveform', '重跑并看波形') : ''}
      ${view.canJoinEditors ? button('joinEditors', '合并编辑器组') : ''}
      ${button('history', '测试历史')}`),
    body: html.raw(`
      <p>${renderBadge(label, tone)} <span class="muted">${html.text(view.profile)} · 复现编号</span> ${html.code(view.caseId)}</p>
      ${view.previousCaseId ? `<p class="muted">重跑自 ${html.code(view.previousCaseId)}。原始记录仍保留在测试历史中；本次使用当前 CPU 源码和保存的测试程序。</p>` : ''}
      <div class="notice${view.status === 'failed' ? ' bad' : ''}"><p class="diagnosis">${html.text(summary || '没有保存具体诊断。')}</p></div>
      ${view.scopeNotice ? `<div class="notice">${html.text(view.scopeNotice)}</div>` : ''}
      <p role="status" aria-live="polite">${html.text(view.actionMessage ?? (view.busy ? '正在检查当前 CPU，可在进度通知中取消。' : ''))}</p>
      <h2>${evidence?.index !== undefined ? `首个差异 · 第 ${evidence.index + 1} 项检查` : view.status === 'failed' ? '失败证据' : '本次检查'}</h2>
      ${evidence?.oracle || evidence?.dut ? renderTable(['来源', 'PC', '写入目标', '写入值'], eventRows) : '<p class="muted">具体检查见上方诊断；本记录没有可并列展示的写回事件。</p>'}
      <div class="source-grid">${targets}</div>
      ${view.sourceAvailable ? '<p class="muted">测试汇编是保存的程序快照，用于定位；修复请修改 CPU 源文件。</p>' : ''}
      <div class="actions">${button('compare', '对比写回记录', view.compareAvailable)}
        ${view.dutAvailable ? button('dut', '查看 CPU 输出') : ''}
        ${view.sourceAvailable && !view.targets.some(target => target.line) ? button('program', '打开测试汇编') : ''}</div>
      ${!view.compareAvailable ? '<p class="muted">本记录没有成对的写回结果可供比较。</p>' : ''}
      <h2>下一步</h2><p>${html.text(view.profile === 'P3' && view.status === 'failed'
        ? '先对照测试汇编和差异之前的写回记录，再在 Logisim 中检查对应指令的数据通路与控制信号。首个可观察差异不一定是根因。'
        : failureNextStep(view.status, view.diagnostic, evidence))}</p>
      ${view.canWaveform ? '<p class="muted">波形来自一次新的重跑，使用自动测试环境。打开后可点击写回事件查看对应时刻。</p>' : ''}
      ${view.warnings.length ? `<div class="notice"><strong>部分证据不可用</strong><ul>${view.warnings.map(warning => `<li>${html.text(warning)}</li>`).join('')}</ul></div>` : ''}
      <details${view.status === 'error' ? ' open' : ''}><summary>更多排查工具与运行日志</summary><div class="actions">
        ${view.logs.map((name, index) => button('log', name, true, index)).join('')}
        ${view.canHazard ? button('hazard', '分析此程序的流水线冲突') : ''}
        ${view.sourceAvailable ? button('program', '打开完整测试汇编') : ''}</div>
        ${view.canHazard ? '<p class="muted">冲突分析使用参考流水线模型，可辅助检查转发与阻塞；其中周期不是待测 CPU 的实测周期，也不复现 P7 外设时序。</p>' : ''}
        ${!view.canRerun ? '<p class="muted">此历史记录不具备可重跑的完整程序快照。请重新启动持续测试生成新用例。</p>' : ''}
      </details>`)
  });
}
