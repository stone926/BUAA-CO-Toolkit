// @index toolchain-report — 工具链检查结果的纯 HTML 报告渲染
import type { ToolDetection } from '../types';
import {
  html,
  renderBadge,
  renderMetricGrid,
  renderReportPage,
  renderTable
} from './reportLayout';

/** Renders the host-provided tool checks without depending on VS Code APIs. */
export function renderToolchainReport(checks: readonly ToolDetection[]): string {
  const available = checks.filter((check) => check.ok).length;
  const pending = checks.length - available;
  const rows = checks.map((check) => ({
    className: check.ok ? 'tool-row-ok' : 'tool-row-pending',
    cells: [
      html.text(check.name),
      renderBadge(check.ok ? '可用' : '待处理', check.ok ? 'ok' : 'bad'),
      html.text(check.detail),
      check.suggestion
        ? html.raw(`<div class="tool-suggestion">${html.text(check.suggestion)}</div>`)
        : html.text('—')
    ]
  }));

  const body = html.raw([
    renderMetricGrid([
      { label: '检查总数', value: checks.length, tone: 'neutral' },
      { label: '可用', value: available, tone: pending ? 'neutral' : 'ok' },
      { label: '待处理', value: pending, tone: pending ? 'warn' : 'ok' }
    ]).toString(),
    renderTable(
      ['工具', '状态', '检测结果', '建议'],
      rows,
      { label: '检查详情', emptyMessage: '当前项目没有需要检查的外部工具。内置工具仍可正常使用。' }
    ).toString()
  ].join('\n'));

  return renderReportPage({
    title: 'CO 工具链',
    eyebrow: '环境检查',
    subtitle: '这里列出当前项目运行课程功能所需的工具及其检测结果。待处理项会附上配置或安装建议。',
    body,
    extraCss: `
      .tool-row-pending td:last-child { min-width: 220px; }
      .tool-suggestion {
        border-left: 3px solid var(--vscode-editorWarning-foreground);
        padding: 3px 0 3px 9px;
        color: var(--vscode-editorWarning-foreground);
      }
    `
  });
}
