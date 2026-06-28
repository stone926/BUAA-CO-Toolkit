import { escapeHtml } from '../language/common/util';
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
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
${reportCss}
${options.extraCss ?? ''}
  </style>
</head>
<body>
  <h1>${html.text(options.title)}</h1>
${options.body}
</body>
</html>`;
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

const reportCss = `
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    h1 {
      font-size: 22px;
      margin: 0 0 16px;
    }
    h2 {
      font-size: 16px;
      margin: 20px 0 10px;
    }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px;
      margin-bottom: 16px;
    }
    .metric {
      border: 1px solid var(--vscode-panel-border);
      padding: 10px;
    }
    .metric strong {
      display: block;
      font-size: 18px;
    }
    .paths {
      margin: 0 0 16px;
      color: var(--vscode-descriptionForeground);
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border-bottom: 1px solid var(--vscode-panel-border);
      padding: 7px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      background: var(--vscode-editor-background);
    }
    code {
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 4px;
      word-break: break-word;
    }
    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: var(--vscode-textCodeBlock-background);
      padding: 10px;
    }
    .ok {
      color: var(--vscode-testing-iconPassed);
    }
    .bad, .warn {
      color: var(--vscode-testing-iconFailed);
    }
`;
