import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { Diagnostic } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { defaultCoSettings, mergeCoSettings } from '../../language/common/settings';
import { parseMips } from '../../language/mips/parser';
import { getVerilogDiagnostics } from '../../language/verilog/service';

interface ExpectedDiagnostic {
  code: string;
  line: number;
}

interface FixtureExpectation {
  diagnostics: ExpectedDiagnostic[];
}

const fixtureRoot = path.join(process.cwd(), 'src', 'test', 'fixtures', 'syntax');

describe('syntax fixtures', () => {
  for (const fixture of fixtureFiles(path.join(fixtureRoot, 'mips', 'valid'), ['.s', '.asm', '.mips'])) {
    it(`accepts valid MIPS fixture ${path.basename(fixture)}`, () => {
      const diagnostics = mipsDiagnostics(fixture);
      expect(syntaxBlockingCodes(diagnostics)).toEqual([]);
    });
  }

  for (const fixture of fixtureFiles(path.join(fixtureRoot, 'mips', 'course'), ['.s', '.asm', '.mips'])) {
    it(`accepts course MIPS fixture ${path.basename(fixture)}`, () => {
      const diagnostics = mipsDiagnostics(fixture);
      expect(syntaxBlockingCodes(diagnostics)).toEqual([]);
    });
  }

  for (const fixture of fixtureFiles(path.join(fixtureRoot, 'mips', 'invalid'), ['.s', '.asm', '.mips'])) {
    it(`matches invalid MIPS fixture ${path.basename(fixture)}`, () => {
      expectDiagnostics(mipsDiagnostics(fixture), readExpectation(fixture));
    });
  }

  for (const fixture of fixtureFiles(path.join(fixtureRoot, 'verilog', 'valid'), ['.v'])) {
    it(`accepts valid Verilog fixture ${path.basename(fixture)}`, () => {
      const diagnostics = verilogDiagnostics(fixture);
      expect(diagnostics.filter((diagnostic) => codeOf(diagnostic).startsWith('syntax-'))).toEqual([]);
    });
  }

  for (const fixture of fixtureFiles(path.join(fixtureRoot, 'verilog', 'invalid'), ['.v'])) {
    it(`matches invalid Verilog fixture ${path.basename(fixture)}`, () => {
      expectDiagnostics(verilogDiagnostics(fixture), readExpectation(fixture));
    });
  }
});

function fixtureFiles(root: string, extensions: string[]): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs.readdirSync(root)
    .filter((name) => extensions.includes(path.extname(name)))
    .map((name) => path.join(root, name))
    .sort();
}

function mipsDiagnostics(file: string): Diagnostic[] {
  const text = fs.readFileSync(file, 'utf8');
  const document = TextDocument.create(URI.file(file).toString(), 'mipsasm', 1, text);
  return parseMips(document, defaultCoSettings).diagnostics;
}

function verilogDiagnostics(file: string): Diagnostic[] {
  const text = fs.readFileSync(file, 'utf8');
  const document = TextDocument.create(URI.file(file).toString(), 'verilog', 1, text);
  return getVerilogDiagnostics(document, mergeCoSettings({}));
}

function readExpectation(fixture: string): FixtureExpectation {
  const expectationPath = fixture.replace(/\.[^.]+$/, '.json');
  return JSON.parse(fs.readFileSync(expectationPath, 'utf8')) as FixtureExpectation;
}

function expectDiagnostics(actual: Diagnostic[], expectation: FixtureExpectation): void {
  for (const expected of expectation.diagnostics) {
    expect(actual.some((diagnostic) =>
      codeOf(diagnostic) === expected.code &&
      diagnostic.range.start.line + 1 === expected.line
    )).toBe(true);
  }
}

function syntaxBlockingCodes(diagnostics: Diagnostic[]): string[] {
  return diagnostics
    .map(codeOf)
    .filter((code) => code.startsWith('mips-lex-') || code.startsWith('mips-syntax-') || code.startsWith('syntax-') || code === 'directive-operand' || code === 'directive-operand-count');
}

function codeOf(diagnostic: Diagnostic): string {
  return typeof diagnostic.code === 'string' ? diagnostic.code : '';
}
