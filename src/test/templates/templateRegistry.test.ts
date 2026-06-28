import { describe, expect, it } from 'vitest';
import { renderResourceTemplate, renderTemplateText } from '../../templates/templateRegistry';

describe('template registry', () => {
  it('replaces explicit placeholders without evaluating code', () => {
    expect(renderTemplateText('module ${name};\n${body}\nendmodule\n', {
      name: 'demo',
      body: '    wire a;'
    })).toBe('module demo;\n    wire a;\nendmodule\n');
  });

  it('fails fast for missing placeholders', () => {
    expect(() => renderTemplateText('${known} ${missing}', { known: 'ok' })).toThrow(/missing/i);
  });

  it('renders wizard resource templates', () => {
    expect(renderResourceTemplate('wizard/verilog_top.v.tmpl', {
      date: '2026-06-28',
      ports: '    input clk',
      profile: 'P4',
      topModule: 'mips'
    })).toContain('module mips(\n    input clk\n);');
  });
});
