import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { verilogLintRuleCatalog } from '../language/verilog/lintRuleCatalog';

const generatorPath = path.resolve(process.cwd(), 'scripts', 'generate-diagnostic-catalog.mjs');

function createCatalogFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-diagnostic-catalog-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'resources', 'verilog'), { recursive: true });
  for (const language of ['mips', 'verilog', 'logisim']) {
    fs.mkdirSync(path.join(root, 'src', 'language', language), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'docs', 'diagnostic-catalog.md'), [
    '# Diagnostic catalog',
    '<!-- generated:diagnostic-codes:start -->',
    '<!-- generated:diagnostic-codes:end -->',
    '<!-- generated:verilog-lint-rules:start -->',
    '<!-- generated:verilog-lint-rules:end -->',
    ''
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'resources', 'verilog', 'lintRules.json'), '[]\n');
  fs.writeFileSync(path.join(root, 'src', 'language', 'mips', 'producer.ts'), "makeDiagnostic(a, b, c, 'mips-literal');\n");
  fs.writeFileSync(path.join(root, 'src', 'language', 'verilog', 'producer.ts'), "const issue = { range, message, code: 'verilog-literal' };\n");
  fs.writeFileSync(path.join(root, 'src', 'language', 'logisim', 'producer.ts'), "makeDiagnostic(a, b, c, `logisim-${kind}`);\n");
  return root;
}

function runGenerator(root: string, ...args: string[]): void {
  execFileSync(process.execPath, [generatorPath, ...args], { cwd: root, stdio: 'pipe' });
}

describe('diagnostic catalog docs', () => {
  it('keeps the generated MIPS, Verilog, and Logisim diagnostic inventory in sync with producers', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-diagnostic-catalog.mjs', '--check'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    })).not.toThrow();
  });

  it('lists Logisim diagnostics and dynamic families in the generated inventory', () => {
    const text = fs.readFileSync(path.join(process.cwd(), 'docs', 'diagnostic-catalog.md'), 'utf8');
    for (const code of ['circ-project', 'circ-xml', 'missing-label', 'memory-contents', 'memory-widths']) {
      expect(text).toContain(`| logisim | \`${code}\` |`);
    }
    for (const code of [
      'pseudo-instruction:<mnemonic>',
      'implicit-net:<name>',
      'missing-port:<name>',
      'syntax-unmatched-<value>',
      '<profile>-port-width'
    ]) {
      expect(text).toContain(`\`${code}\``);
    }
  });

  it('documents every Verilog lint rule from the catalog', () => {
    const text = fs.readFileSync(path.join(process.cwd(), 'docs', 'diagnostic-catalog.md'), 'utf8');
    for (const rule of verilogLintRuleCatalog) {
      expect(text).toContain(`\`${rule.id}\``);
      expect(text).toContain(rule.title);
      expect(text).toContain(rule.description);
    }
  });

  it('fails closed for new codes, unsupported expressions, and missing markers', () => {
    const root = createCatalogFixture();
    try {
      runGenerator(root);
      runGenerator(root, '--check');
      const generated = fs.readFileSync(path.join(root, 'docs', 'diagnostic-catalog.md'), 'utf8');
      expect(generated).toContain('`mips-literal`');
      expect(generated).toContain('`verilog-literal`');
      expect(generated).toContain('`logisim-<kind>`');

      const mipsProducer = path.join(root, 'src', 'language', 'mips', 'producer.ts');
      fs.appendFileSync(mipsProducer, "makeDiagnostic(a, b, c, 'new-mips-code');\n");
      let staleCatalogError: { stderr?: Buffer } | undefined;
      try {
        runGenerator(root, '--check');
      } catch (error) {
        staleCatalogError = error as { stderr?: Buffer };
      }
      expect(staleCatalogError?.stderr?.toString()).toContain('not generated from diagnostic producers');

      fs.writeFileSync(mipsProducer, 'makeDiagnostic(a, b, c, buildCode());\n');
      let dynamicCodeError: { stderr?: Buffer } | undefined;
      try {
        runGenerator(root);
      } catch (error) {
        dynamicCodeError = error as { stderr?: Buffer };
      }
      expect(dynamicCodeError?.stderr?.toString()).toContain('Cannot statically catalog diagnostic code');

      fs.writeFileSync(mipsProducer, "makeDiagnostic(a, b, c, 'mips-literal');\n");
      fs.writeFileSync(path.join(root, 'docs', 'diagnostic-catalog.md'), '# Missing markers\n');
      let markerError: { stderr?: Buffer } | undefined;
      try {
        runGenerator(root, '--check');
      } catch (error) {
        markerError = error as { stderr?: Buffer };
      }
      expect(markerError?.stderr?.toString()).toContain('Missing or invalid generated catalog markers');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
