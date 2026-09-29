import { randomBytes } from 'crypto';
import { escapeHtml } from '../language/common/util';
import { renderResourceTemplate } from '../templates/templateRegistry';
// @index orchestration — Webview 报告页面布局、表格、metric 和转义 helper

export interface ReportMetric {
  label: string;
  value: string | number | boolean;
  tone?: ReportTone;
}

export type ReportTone = 'ok' | 'bad' | 'warn' | 'neutral';

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
  eyebrow?: string;
  subtitle?: string;
  actions?: SafeHtml;
  body: SafeHtml;
  extraCss?: string;
  script?: 'history' | 'continuous';
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
  const nonce = randomBytes(18).toString('base64');
  return renderResourceTemplate('webview/report_page.html', {
    nonce,
    eyebrow: String(html.text(options.eyebrow ?? 'BUAA CO TOOLKIT')),
    subtitle: options.subtitle ? `<p class="subtitle">${html.text(options.subtitle)}</p>` : '',
    actions: options.actions ? `<nav class="actions" aria-label="报告操作">${options.actions}</nav>` : '',
    script: options.script ? `<script nonce="${nonce}">${renderResourceTemplate(
      options.script === 'history' ? 'webview/reportFilter.js' : 'webview/continuousActions.js', {}
    )}</script>` : '',
    body: renderSafeHtml(options.body),
    extraCss: options.extraCss ?? '',
    reportCss: renderResourceTemplate('webview/report.css', {}),
    title: renderSafeHtml(html.text(options.title))
  });
}

export function renderMetricGrid(metrics: readonly ReportMetric[]): SafeHtml {
  return html.raw(`<div class="summary">
${metrics.map((metric) => `    <div class="metric${metric.tone ? ` ${html.text(metric.tone)}` : ''}"><span>${html.text(metric.label)}</span><strong>${html.text(metric.value)}</strong></div>`).join('\n')}
  </div>`);
}

export function renderBadge(label: string, tone: ReportTone = 'neutral'): SafeHtml {
  return html.raw(`<span class="badge ${html.text(tone)}">${html.text(label)}</span>`);
}

export function renderTable(columns: readonly string[], rows: readonly ReportTableRow[], options: { label?: string; emptyMessage?: string } = {}): SafeHtml {
  if (!rows.length) return html.raw(`<div class="empty-state">${html.text(options.emptyMessage ?? '暂无记录')}</div>`);
  return html.raw(`<div class="table-scroll" role="region" aria-label="${html.text(options.label ?? '报告明细')}" tabindex="0"><table>
    <thead>
      <tr>${columns.map((column) => `<th scope="col">${html.text(column)}</th>`).join('')}</tr>
    </thead>
    <tbody>${rows.map((row) => `<tr${row.className ? ` class="${html.text(row.className)}"` : ''}>${row.cells.map((cell) => `<td>${renderCell(cell)}</td>`).join('')}</tr>`).join('\n')}</tbody>
  </table></div>`);
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
