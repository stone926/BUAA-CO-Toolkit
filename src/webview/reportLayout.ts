import { escapeHtml } from '../language/common/util';
import { renderResourceTemplate } from '../templates/templateRegistry';
// @index orchestration — Webview 报告页面布局、表格、metric 和转义 helper

export interface ReportMetric {
  label: string;
  value: string | number | boolean;
}

export interface ReportTableRow {
  className?: string;
  cells: string[];
}

export interface ReportPageOptions {
  title: string;
  body: string;
  extraCss?: string;
}

export const html = {
  text(value: unknown): string {
    return escapeHtml(String(value ?? ''));
  },

  code(value: unknown): string {
    return `<code>${escapeHtml(String(value ?? ''))}</code>`;
  },

  path(value: unknown): string {
    return `<code>${escapeHtml(String(value ?? ''))}</code>`;
  }
};

export function renderReportPage(options: ReportPageOptions): string {
  return renderResourceTemplate('webview/report_page.html', {
    body: options.body,
    extraCss: options.extraCss ?? '',
    reportCss: renderResourceTemplate('webview/report.css', {}),
    title: html.text(options.title)
  });
}

export function renderMetricGrid(metrics: readonly ReportMetric[]): string {
  return `<div class="summary">
${metrics.map((metric) => `    <div class="metric"><span>${html.text(metric.label)}</span><strong>${html.text(metric.value)}</strong></div>`).join('\n')}
  </div>`;
}

export function renderTable(columns: readonly string[], rows: readonly ReportTableRow[]): string {
  return `<table>
    <thead>
      <tr>${columns.map((column) => `<th>${html.text(column)}</th>`).join('')}</tr>
    </thead>
    <tbody>${rows.map((row) => `<tr${row.className ? ` class="${html.text(row.className)}"` : ''}>${row.cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('\n')}</tbody>
  </table>`;
}
