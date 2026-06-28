import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

interface DeprecatedExportGroup {
  readonly source: string;
  readonly identifiers: readonly string[];
}

const deprecatedExportGroups: readonly DeprecatedExportGroup[] = [
  {
    source: 'src/language/verilog/cst.ts',
    identifiers: [
      'VerilogCstStatement',
      'VerilogCstDocument',
      'parseVerilogCst'
    ]
  },
  {
    source: 'src/language/mips/syntax.ts',
    identifiers: [
      'parseOperands',
      'CstRange',
      'MipsCstTokenKind',
      'MipsCstToken',
      'MipsCstLabel',
      'MipsCstOperand',
      'MipsCstExecutable',
      'MipsCstBaseLine',
      'MipsCstBlankLine',
      'MipsCstCommentLine',
      'MipsCstStatementLine',
      'MipsCstLine',
      'MipsCstDocument',
      'parseMipsCstDocument',
      'parseMipsCstLine',
      'mipsCstTokenRange',
      'mipsCstRange'
    ]
  }
];

describe('deprecated compatibility exports', () => {
  it('are not consumed by production source outside their compatibility module', () => {
    const productionFiles = listProductionSourceFiles(path.join(process.cwd(), 'src'));
    const violations: string[] = [];

    for (const group of deprecatedExportGroups) {
      const sourcePath = normalizeRelativePath(group.source);
      const pattern = new RegExp(`\\b(?:${group.identifiers.map(escapeRegExp).join('|')})\\b`, 'g');
      for (const file of productionFiles) {
        if (file === sourcePath) {
          continue;
        }
        const text = readFileSync(path.join(process.cwd(), file), 'utf8');
        const matches = [...new Set(text.match(pattern) ?? [])];
        if (matches.length > 0) {
          violations.push(`${file}: ${matches.join(', ')}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function listProductionSourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const absolute = path.join(root, entry);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      if (entry !== 'test') {
        files.push(...listProductionSourceFiles(absolute));
      }
      continue;
    }
    if (entry.endsWith('.ts')) {
      files.push(normalizeRelativePath(path.relative(process.cwd(), absolute)));
    }
  }
  return files;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
