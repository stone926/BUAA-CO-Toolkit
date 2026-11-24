// @index user-asm-batch-report — 用户汇编测试的文件名、CPU 目标及可复现结果报告
import { html, renderBadge, renderMetricGrid, renderReportPage, renderTable } from '../webview/reportLayout';
import type { UserAsmBatchReport } from './userAsmBatch';
import type { CourseTracePhase } from './traceRunner';

const phaseLabel: Record<CourseTracePhase, string> = {
  prepare: '正在保存源码与自定义指令快照',
  assemble: '正在选择参考引擎并汇编',
  oracle: '正在执行参考程序',
  compile: '正在准备和编译待测 CPU',
  simulate: '正在仿真待测 CPU',
  compare: '正在对比写回记录'
};

export function renderUserAsmBatchReport(report: UserAsmBatchReport): string {
  const iteration = report.iteration;
  const status = { running: '运行中', passed: '通过', failed: '失败', error: '错误', stopped: '已取消' }[iteration.status];
  const actions = html.raw(`${report.running ? '<button data-report-action="stop" type="button">停止测试</button>' : ''}<button data-report-action="openHistory" type="button">测试历史 / 失败用例</button>`);
  const results = [...iteration.results].sort((left, right) => (left.caseIndex ?? 0) - (right.caseIndex ?? 0));
  return renderReportPage({
    title: '用户汇编 CPU 测试', subtitle: status, actions, script: 'continuous',
    body: html.raw(`<section><p>CPU 工程入口：${html.path(report.cpuResource)}</p><p>汇编输入：${html.path(report.input)}</p><p>按文件名顺序测试，首次失败或错误后停止。目录仅包含直属汇编文件。</p></section>
${renderMetricGrid([
  { label: '测试点', value: report.totalCases }, { label: '通过', value: iteration.summary.passed, tone: 'ok' },
  { label: '失败', value: iteration.summary.failed, tone: 'bad' }, { label: '错误', value: iteration.summary.errors, tone: 'warn' },
  { label: '未完成', value: Math.max(0, report.totalCases - iteration.summary.total) }
])}
${iteration.activeCase ? `<p>测试点 ${iteration.activeCase.index + 1}/${report.totalCases} · ${report.phase ? phaseLabel[report.phase] : '准备中'}</p>` : ''}
${iteration.message ? `<p>${html.text(iteration.message)}</p>` : ''}
${renderTable(['序号', '汇编文件', '标准输入', '参考引擎', '结果', '说明', '用例'], results.map(result => ({ cells: [
  (result.caseIndex ?? 0) + 1, html.path(result.asm), result.stdin ? html.path(result.stdin) : '无',
  result.referenceEngine === 'custom-mars' ? '自定义 Mars' : result.referenceEngine === 'builtin-ts' ? '内置引擎' : '未确定',
  renderBadge(result.status === 'passed' ? '通过' : result.status === 'failed' ? '失败' : '错误', result.status === 'passed' ? 'ok' : 'bad'),
  result.referenceNote ? `${result.message}；${result.referenceNote}` : result.message,
  result.caseId ? (result.artifactsPruned ? `${result.caseId}（已清理）` : html.raw(`<button type="button" data-report-action="inspectCase" data-case-id="${html.text(result.caseId)}">${html.text(result.caseId)}</button>`)) : ''
]})), { emptyMessage: report.running ? '尚无已完成的测试点' : '没有已完成的测试点' })}
<p class="report-footnote">通过表示本次程序的可观察结果满足检查；课程周期和内部结构仍需另行验证。</p>`)
  });
}
