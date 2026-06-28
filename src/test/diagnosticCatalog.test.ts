import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { verilogLintRuleCatalog } from '../language/verilog/lintRuleCatalog';

describe('diagnostic catalog docs', () => {
  it('keeps generated Verilog lint catalog docs in sync with lintRules.json', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-diagnostic-catalog.mjs', '--check'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    })).not.toThrow();
  });

  it('documents every Verilog lint rule from the catalog', () => {
    const text = fs.readFileSync(path.join(process.cwd(), 'docs', 'diagnostic-catalog.md'), 'utf8');
    for (const rule of verilogLintRuleCatalog) {
      expect(text).toContain(`\`${rule.id}\``);
      expect(text).toContain(rule.title);
      expect(text).toContain(rule.description);
    }
  });
});
