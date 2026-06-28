import { describe, expect, it } from 'vitest';
import {
  html,
  renderMetricGrid,
  renderReportPage,
  renderTable
} from '../../webview/reportLayout';

describe('webview report layout', () => {
  it('escapes page, metric, table, and code content', () => {
    const page = renderReportPage({
      title: '<Report>',
      body: html.raw([
        renderMetricGrid([{ label: '<Total>', value: '<1>' }]),
        renderTable(['<Name>'], [{ className: 'ok', cells: [html.code('<path>')] }])
      ].join('\n'))
    });

    expect(page).toContain('&lt;Report&gt;');
    expect(page).toContain('&lt;Total&gt;');
    expect(page).toContain('&lt;Name&gt;');
    expect(page).toContain('<code>&lt;path&gt;</code>');
    expect(page).not.toContain('<Report>');
  });

  it('escapes primitive table cells by default and requires explicit raw html cells', () => {
    const table = renderTable(
      ['Value'],
      [
        { cells: ['<script>bad()</script>'] },
        { cells: [html.raw('<strong>safe</strong>')] }
      ]
    ).toString();

    expect(table).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(table).toContain('<strong>safe</strong>');
  });
});
