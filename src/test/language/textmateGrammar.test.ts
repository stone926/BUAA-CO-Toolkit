import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  INITIAL,
  Registry,
  parseRawGrammar,
  type IGrammar,
  type IRawGrammar,
} from 'vscode-textmate';
import {
  createOnigScanner,
  createOnigString,
  loadWASM,
} from 'vscode-oniguruma';

const projectRoot = process.cwd();
const requireFromProject = createRequire(path.join(projectRoot, 'package.json'));
const grammarFiles: Readonly<Record<string, string>> = {
  'source.mips': path.join(projectRoot, 'syntaxes', 'mips.tmLanguage.json'),
  'source.verilog': path.join(projectRoot, 'syntaxes', 'verilog.tmLanguage.json'),
  'source.systemverilog.co': path.join(projectRoot, 'syntaxes', 'systemverilog.tmLanguage.json'),
};

interface ScopedToken {
  startIndex: number;
  endIndex: number;
  scopes: string[];
}

interface TokenizedLine {
  text: string;
  tokens: ScopedToken[];
  ruleStackDepth: number;
}

let registry: Registry;
let mipsGrammar: IGrammar;
let verilogGrammar: IGrammar;
let systemVerilogGrammar: IGrammar;

async function loadRawGrammar(scopeName: string): Promise<IRawGrammar | null> {
  const filePath = grammarFiles[scopeName];
  if (!filePath) {
    return null;
  }
  return parseRawGrammar(await readFile(filePath, 'utf8'), filePath);
}

async function requireGrammar(scopeName: string): Promise<IGrammar> {
  const grammar = await registry.loadGrammar(scopeName);
  if (!grammar) {
    throw new Error(`Unable to load TextMate grammar ${scopeName}`);
  }
  return grammar;
}

function tokenize(grammar: IGrammar, source: string): TokenizedLine[] {
  let ruleStack = INITIAL;
  return source.split(/\r\n|\n|\r/).map((text) => {
    const result = grammar.tokenizeLine(text, ruleStack);
    ruleStack = result.ruleStack;
    return {
      text,
      tokens: result.tokens.map((token) => ({
        startIndex: token.startIndex,
        endIndex: token.endIndex,
        scopes: token.scopes,
      })),
      ruleStackDepth: result.ruleStack.depth,
    };
  });
}

function indexOfOccurrence(text: string, needle: string, occurrence: number): number {
  let index = -1;
  for (let current = 0; current <= occurrence; current += 1) {
    index = text.indexOf(needle, index + 1);
    if (index < 0) {
      throw new Error(`Unable to find occurrence ${occurrence} of ${JSON.stringify(needle)} in ${JSON.stringify(text)}`);
    }
  }
  return index;
}

function scopesAt(
  lines: TokenizedLine[],
  lineIndex: number,
  needle: string,
  occurrence = 0,
): string[] {
  const line = lines[lineIndex];
  const index = indexOfOccurrence(line.text, needle, occurrence);
  const token = line.tokens.find(
    (candidate) => candidate.startIndex <= index && candidate.endIndex > index,
  );
  if (!token) {
    throw new Error(`No TextMate token covers ${JSON.stringify(needle)} in ${JSON.stringify(line.text)}`);
  }
  return token.scopes;
}

function expectScope(scopes: string[], expected: string): void {
  expect(scopes, `expected scope ${expected}`).toContain(expected);
}

beforeAll(async () => {
  const wasmPath = requireFromProject.resolve('vscode-oniguruma/release/onig.wasm');
  const wasm = await readFile(wasmPath);
  await loadWASM(wasm);
  registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: loadRawGrammar,
  });
  mipsGrammar = await requireGrammar('source.mips');
  verilogGrammar = await requireGrammar('source.verilog');
  systemVerilogGrammar = await requireGrammar('source.systemverilog.co');
});

afterAll(() => {
  registry.dispose();
});

describe('generated TextMate grammars', () => {
  it('stays synchronized with the MIPS and Verilog language resources', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'scripts', 'generate-syntaxes.mjs'), '--check'],
      { cwd: projectRoot, encoding: 'utf8' },
    );

    expect(result.stderr || result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('recognizes MIPS statement slots, multiple labels, literals, registers, and macros', () => {
    const lines = tokenize(mipsGrammar, [
      "head: tail: ADD $F31, 'Z', -1.25e+2",
      'j add',
      'lw $t0, data($t1)',
      '.MYSTERY 1',
      '.TEXT',
      '.MACRO KNOWN(%arg)',
      '.END_MACRO',
      'KNOWN($T0)',
      'bare_macro $t1',
      '_co_internal_unknown_instruction',
      ".byte '#', '\\n' # trailing comment",
    ].join('\n'));

    expectScope(scopesAt(lines, 0, 'head'), 'entity.name.label.mips');
    expectScope(scopesAt(lines, 0, 'tail'), 'entity.name.label.mips');
    expectScope(scopesAt(lines, 0, 'ADD'), 'keyword.control.instruction.mips');
    expectScope(scopesAt(lines, 0, '$F31'), 'variable.language.register.floating-point.mips');
    expectScope(scopesAt(lines, 0, "'Z'"), 'constant.character.mips');
    expectScope(scopesAt(lines, 0, '-1.25e+2'), 'constant.numeric.float.mips');
    expectScope(scopesAt(lines, 3, '.MYSTERY'), 'keyword.directive.unknown.mips');
    expectScope(scopesAt(lines, 4, '.TEXT'), 'keyword.directive.mips');
    expectScope(scopesAt(lines, 5, 'KNOWN'), 'entity.name.function.macro.mips');
    expectScope(scopesAt(lines, 5, '%arg'), 'variable.parameter.macro.mips');
    expectScope(scopesAt(lines, 7, 'KNOWN'), 'entity.name.function.macro-call.mips');
    expectScope(scopesAt(lines, 7, '$T0'), 'variable.language.register.mips');
    expectScope(scopesAt(lines, 8, 'bare_macro'), 'entity.name.function.macro-call.mips');

    expect(scopesAt(lines, 1, 'add')).not.toContain('keyword.control.instruction.mips');
    expect(scopesAt(lines, 1, 'add')).not.toContain('entity.name.function.macro-call.mips');
    expect(scopesAt(lines, 2, 'data')).not.toContain('keyword.control.instruction.mips');
    expect(scopesAt(lines, 2, 'data')).not.toContain('entity.name.function.macro-call.mips');
    expect(scopesAt(lines, 9, '_co_internal_unknown_instruction')).not.toEqual(
      expect.arrayContaining([
        'keyword.control.instruction.mips',
        'entity.name.function.macro-call.mips',
      ]),
    );
    expectScope(scopesAt(lines, 10, "'#'"), 'constant.character.mips');
    expectScope(scopesAt(lines, 10, '# trailing'), 'comment.line.number-sign.mips');
  });

  it('ends an unterminated MIPS string at the physical line boundary', () => {
    const lines = tokenize(mipsGrammar, '.asciiz "unterminated\nADD $t0, $t1, $t2');

    expectScope(scopesAt(lines, 0, 'unterminated'), 'string.quoted.double.mips');
    expectScope(scopesAt(lines, 1, 'ADD'), 'keyword.control.instruction.mips');
  });

  it('keeps dollar macro parameters scoped across a MIPS macro block without hiding real registers', () => {
    const lines = tokenize(mipsGrammar, [
      '.macro inc($x, %amount)',
      '  addiu $x, $x, %amount',
      '  addiu $t0, $t0, 1',
      '.end_macro',
      'addiu $x, $t0, 1',
    ].join('\n'));

    expectScope(scopesAt(lines, 0, '$x'), 'variable.parameter.macro.mips');
    expectScope(scopesAt(lines, 0, '%amount'), 'variable.parameter.macro.mips');
    expectScope(scopesAt(lines, 1, '$x', 0), 'variable.parameter.macro.mips');
    expectScope(scopesAt(lines, 1, '$x', 1), 'variable.parameter.macro.mips');
    expectScope(scopesAt(lines, 1, '%amount'), 'variable.parameter.macro.mips');
    expectScope(scopesAt(lines, 2, '$t0', 0), 'variable.language.register.mips');
    expectScope(scopesAt(lines, 2, '$t0', 1), 'variable.language.register.mips');
    expect(scopesAt(lines, 2, '$t0')).not.toContain('variable.parameter.macro.mips');
    expect(scopesAt(lines, 4, '$x')).not.toContain('variable.parameter.macro.mips');
    expect(lines[0].ruleStackDepth).toBeGreaterThan(1);
    expect(lines[2].ruleStackDepth).toBeGreaterThan(1);
    expect(lines[3].ruleStackDepth).toBe(1);
    expect(lines[4].ruleStackDepth).toBe(1);
  });

  it('covers Verilog directives, macros, keyword groups, identifiers, numbers, and operators', () => {
    const lines = tokenize(verilogGrammar, [
      '`define WIDTH 16',
      '`ifdef FEATURE',
      '`USER_MACRO(WIDTH)',
      'module top;',
      'wire \\escaped.name  = 16\'shA_Fx;',
      'real r = 1_2.3_4e-5; integer n = 1_000;',
      'initial $display("%08h %%", r); $custom_task(r);',
      'initial $readmemh("rom%h.mem", memory);',
      'assign bits[7 +: 4] = a === b ? a <<< 2 : b;',
      'always module logic signed and strong1 config defparam',
      "wire [15:0] n = 16'b1010_1011_1111_1010; wire [3:0] x = 4'b10??; wire [7:0] h = 'hff;",
    ].join('\n'));

    expectScope(scopesAt(lines, 0, 'define'), 'keyword.control.directive.verilog');
    expectScope(scopesAt(lines, 0, 'WIDTH'), 'entity.name.function.preprocessor.verilog');
    expectScope(scopesAt(lines, 1, 'ifdef'), 'keyword.control.directive.verilog');
    expectScope(scopesAt(lines, 1, 'FEATURE'), 'variable.other.preprocessor.verilog');
    expectScope(scopesAt(lines, 2, 'USER_MACRO'), 'entity.name.function.preprocessor.verilog');
    expectScope(scopesAt(lines, 4, '\\escaped.name'), 'variable.other.identifier.escaped.verilog');
    expectScope(scopesAt(lines, 4, "16'shA_Fx"), 'constant.numeric.verilog');
    expectScope(scopesAt(lines, 5, '1_2.3_4e-5'), 'constant.numeric.verilog');
    expectScope(scopesAt(lines, 5, '1_000'), 'constant.numeric.verilog');
    expectScope(scopesAt(lines, 6, '$display'), 'support.function.system-task.verilog');
    expectScope(scopesAt(lines, 6, '$custom_task'), 'support.function.system-task.verilog');
    expectScope(scopesAt(lines, 6, '%08h'), 'constant.other.placeholder.verilog');
    expectScope(scopesAt(lines, 6, '%%'), 'constant.other.placeholder.verilog');
    expectScope(scopesAt(lines, 8, '+:'), 'keyword.operator.verilog');
    expectScope(scopesAt(lines, 8, '==='), 'keyword.operator.verilog');
    expectScope(scopesAt(lines, 8, '?'), 'keyword.operator.verilog');
    expectScope(scopesAt(lines, 8, '<<<'), 'keyword.operator.verilog');
    expectScope(scopesAt(lines, 8, '['), 'punctuation.section.group.verilog');

    expectScope(scopesAt(lines, 9, 'always'), 'keyword.control.verilog');
    expectScope(scopesAt(lines, 9, 'module'), 'keyword.declaration.verilog');
    expectScope(scopesAt(lines, 9, 'logic'), 'storage.type.verilog');
    expectScope(scopesAt(lines, 9, 'signed'), 'storage.modifier.verilog');
    expectScope(scopesAt(lines, 9, 'and'), 'support.function.primitive.verilog');
    expectScope(scopesAt(lines, 9, 'strong1'), 'constant.language.strength.verilog');
    expectScope(scopesAt(lines, 9, 'config'), 'keyword.other.configuration.verilog');
    expectScope(scopesAt(lines, 9, 'defparam'), 'keyword.other.unsupported.verilog');
    expectScope(scopesAt(lines, 10, "16'b1010_1011_1111_1010"), 'constant.numeric.verilog');
    expectScope(scopesAt(lines, 10, "4'b10??"), 'constant.numeric.verilog');
    expectScope(scopesAt(lines, 10, "'hff"), 'constant.numeric.verilog');
  });

  it('limits in-string format scopes to formatting system-task calls', () => {
    const lines = tokenize(verilogGrammar, [
      '$readmemh("rom%h.mem", memory);',
      '$display("value=%h", value);',
    ].join('\n'));

    expect(scopesAt(lines, 0, '%h')).not.toContain('constant.other.placeholder.verilog');
    expectScope(scopesAt(lines, 0, '%h'), 'string.quoted.double.verilog');
    expectScope(scopesAt(lines, 1, '%h'), 'constant.other.placeholder.verilog');
  });

  it('ends an unterminated Verilog string at the physical line boundary', () => {
    const lines = tokenize(verilogGrammar, 'wire value = "unterminated\nmodule recovered;');

    expectScope(scopesAt(lines, 0, 'unterminated'), 'string.quoted.double.verilog');
    expectScope(scopesAt(lines, 1, 'module'), 'keyword.declaration.verilog');
    expect(lines[0].ruleStackDepth).toBe(1);
    expect(lines[1].ruleStackDepth).toBe(1);
  });

  it('preserves a Verilog string ruleStack only for a legal backslash-newline continuation', () => {
    const lines = tokenize(verilogGrammar, [
      '$display("continued\\',
      'value %h", signal);',
      'module recovered;',
    ].join('\n'));

    expectScope(scopesAt(lines, 0, 'continued'), 'string.quoted.double.verilog');
    expectScope(scopesAt(lines, 1, 'value'), 'string.quoted.double.verilog');
    expectScope(scopesAt(lines, 1, '%h'), 'constant.other.placeholder.verilog');
    expect(lines[0].ruleStackDepth).toBeGreaterThan(1);
    expect(lines[1].ruleStackDepth).toBe(1);
    expectScope(scopesAt(lines, 2, 'module'), 'keyword.declaration.verilog');
  });

  it('closes a Verilog string after an even run of trailing backslashes', () => {
    const lines = tokenize(verilogGrammar, [
      'wire value = "not continued\\\\',
      'module recovered;',
    ].join('\n'));

    expect(lines[0].ruleStackDepth).toBe(1);
    expectScope(scopesAt(lines, 1, 'module'), 'keyword.declaration.verilog');
  });

  it('lets SystemVerilog-specific rules win before falling back to Verilog', () => {
    const lines = tokenize(systemVerilogGrammar, [
      "logic value = '0;",
      'always_ff @(posedge clk) value <= 1\'b0;',
      'class packet; packet::kind value_kind; endclass',
      'always_comb begin : count1 value = value + 1; end',
      "packet p = '{default: '0}; ADD instance(.*);",
      'module fallback;',
    ].join('\n'));

    expectScope(scopesAt(lines, 0, 'logic'), 'storage.type.systemverilog');
    expectScope(scopesAt(lines, 1, 'always_ff'), 'keyword.control.systemverilog');
    expectScope(scopesAt(lines, 2, 'class'), 'keyword.declaration.systemverilog');
    expectScope(scopesAt(lines, 2, '::'), 'keyword.operator.systemverilog');
    expectScope(scopesAt(lines, 3, 'count1'), 'entity.name.label.verilog');
    expectScope(scopesAt(lines, 4, '.*'), 'keyword.operator.systemverilog');
    expectScope(scopesAt(lines, 4, "'{"), 'punctuation.definition.verilog');
    expectScope(scopesAt(lines, 5, 'module'), 'keyword.declaration.verilog');
  });

  it('scopes Verilog named begin blocks used by course sources', () => {
    const lines = tokenize(verilogGrammar, 'always @(posedge clk) begin: count1');

    expectScope(scopesAt(lines, 0, 'begin'), 'keyword.control.verilog');
    expectScope(scopesAt(lines, 0, ':'), 'punctuation.separator.label.verilog');
    expectScope(scopesAt(lines, 0, 'count1'), 'entity.name.label.verilog');
  });
});
