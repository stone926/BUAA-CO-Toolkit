import { describe, expect, it } from 'vitest';
import {
  html,
  renderMetricGrid,
  renderReportPage,
  renderTable
} from '../../webview/reportLayout';

describe('webview report layout', () => {
  it('uses a fresh CSP nonce and escapes header metadata even on interactive pages', () => {
    const options = {
      title: 'History', subtitle: '</p><script>alert(1)</script>',
      body: html.text(''), script: 'history' as const
    };
    const page = renderReportPage(options);
    const nonce = page.match(/style-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(page).toContain(`script-src 'nonce-${nonce}'`);
    expect(page).toContain(`<script nonce="${nonce}">`);
    expect(page).toContain(`<style nonce="${nonce}">`);
    expect(page).not.toContain('unsafe-inline');
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(renderReportPage(options)).not.toContain(`nonce-${nonce}`);
    expect(renderReportPage({ title: 'Static', body: html.text('') })).not.toContain('<script');
  });

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
