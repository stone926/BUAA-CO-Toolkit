import { escapeHtml } from '../language/common/util';
import { renderResourceTemplate } from '../templates/templateRegistry';
// @index orchestration — Webview 报告页面布局、表格、metric 和转义 helper

export interface ReportMetric {
  label: string;
  value: string | number | boolean;
}

export interface SafeHtml {
  readonly kind: 'safeHtml';
  readonly value: string;
  toString(): string;
}

export type ReportCell =
  | string
  | number
  | boolean
  | null
  | undefined
  | SafeHtml
  | { kind: 'text' | 'code' | 'path'; value: unknown }
  | { kind: 'html'; value: SafeHtml };

export interface ReportTableRow {
  className?: string;
  cells: ReportCell[];
}

export interface ReportPageOptions {
  title: string;
  body: SafeHtml;
  extraCss?: string;
}

export const html = {
  text(value: unknown): SafeHtml {
    return safeHtml(escapeHtml(String(value ?? '')));
  },

  code(value: unknown): SafeHtml {
    return safeHtml(`<code>${escapeHtml(String(value ?? ''))}</code>`);
  },

  path(value: unknown): SafeHtml {
    return safeHtml(`<code>${escapeHtml(String(value ?? ''))}</code>`);
  },

  raw(value: string): SafeHtml {
    return safeHtml(value);
  }
};

export function renderReportPage(options: ReportPageOptions): string {
  return renderResourceTemplate('webview/report_page.html', {
    body: renderSafeHtml(options.body),
    extraCss: options.extraCss ?? '',
    reportCss: renderResourceTemplate('webview/report.css', {}),
    title: renderSafeHtml(html.text(options.title))
  });
}

export function renderMetricGrid(metrics: readonly ReportMetric[]): SafeHtml {
  return html.raw(`<div class="summary">
${metrics.map((metric) => `    <div class="metric"><span>${html.text(metric.label)}</span><strong>${html.text(metric.value)}</strong></div>`).join('\n')}
  </div>`);
}

export function renderTable(columns: readonly string[], rows: readonly ReportTableRow[]): SafeHtml {
  return html.raw(`<table>
    <thead>
      <tr>${columns.map((column) => `<th>${html.text(column)}</th>`).join('')}</tr>
    </thead>
    <tbody>${rows.map((row) => `<tr${row.className ? ` class="${html.text(row.className)}"` : ''}>${row.cells.map((cell) => `<td>${renderCell(cell)}</td>`).join('')}</tr>`).join('\n')}</tbody>
  </table>`);
}

export function renderSafeHtml(value: SafeHtml): string {
  return value.value;
}

function safeHtml(value: string): SafeHtml {
  return {
    kind: 'safeHtml',
    value,
    toString() {
      return value;
    }
  };
}

function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'object'
    && value !== null
    && (value as { kind?: unknown }).kind === 'safeHtml'
    && typeof (value as { value?: unknown }).value === 'string';
}

function renderCell(cell: ReportCell): string {
  if (isSafeHtml(cell)) {
    return renderSafeHtml(cell);
  }
  if (cell && typeof cell === 'object') {
    if (cell.kind === 'html') {
      return renderSafeHtml(cell.value);
    }
    if (cell.kind === 'code') {
      return renderSafeHtml(html.code(cell.value));
    }
    if (cell.kind === 'path') {
      return renderSafeHtml(html.path(cell.value));
    }
    if (cell.kind === 'text') {
      return renderSafeHtml(html.text(cell.value));
    }
  }
  return renderSafeHtml(html.text(cell ?? ''));
}
