import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  semanticColorPresets,
  semanticColorTokenIds
} from '../semanticColorPresets';
import { defaultDisabledVerilogLintRules } from '../language/common/settings';

interface PackageJson {
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string }>;
    configuration?: Array<{ title: string; properties?: Record<string, { default?: unknown }> }>;
    configurationDefaults?: Record<string, unknown>;
    grammars?: Array<{ language: string; scopeName?: string; path?: string }>;
    languages?: Array<{ id: string; extensions?: string[]; configuration?: string }>;
    menus?: Record<string, Array<{ command: string; when?: string }>>;
    semanticTokenScopes?: Array<{ scopes?: Record<string, string[]> }>;
    semanticTokenTypes?: Array<{ id: string; superType?: string }>;
    views?: Record<string, Array<{ id: string; when?: string }>>;
  };
}

function readPackage(): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as PackageJson;
}

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')) as T;
}

describe('package manifest', () => {
  it('activates every contributed command from a cold start', () => {
    const pkg = readPackage();
    const activationEvents = new Set(pkg.activationEvents ?? []);
    for (const command of pkg.contributes?.commands ?? []) {
      expect(activationEvents.has(`onCommand:${command.command}`), command.command).toBe(true);
    }
  });

  it('activates when the BUAA CO sidebar is opened', () => {
    const pkg = readPackage();
    const activationEvents = new Set(pkg.activationEvents ?? []);
    const viewIds = Object.values(pkg.contributes?.views ?? {}).flat().map((view) => view.id);
    expect(viewIds).toContain('coSidebar');
    expect(activationEvents.has('onView:coSidebar')).toBe(true);
  });

  it('keeps only the public command allowlist visible from the command palette', () => {
    const pkg = readPackage();
    const commandPalette = pkg.contributes?.menus?.commandPalette ?? [];
    const visible = commandPalette
      .filter((item) => item.when !== 'false')
      .map((item) => item.command);

    expect(visible).toEqual([
      'co.projectWizard',
      'co.selectProjectProfile',
      'co.checkToolchain',
      'co.course.openTutorial',
      'co.test.startContinuousGeneratedTraceTests',
      'co.test.stopContinuousTests',
      'co.test.openAsmCaseIndex',
      'co.tools.openAdvanced'
    ]);

    const paletteByCommand = new Map(commandPalette.map((item) => [item.command, item]));
    for (const command of pkg.contributes?.commands ?? []) {
      expect(paletteByCommand.has(command.command), command.command).toBe(true);
      if (!visible.includes(command.command)) {
        expect(paletteByCommand.get(command.command)?.when, command.command).toBe('false');
      }
    }
  });

  it('keeps low-frequency Verilog waveform commands out of editor context and command palette', () => {
    const pkg = readPackage();
    const commands = new Set((pkg.contributes?.commands ?? []).map((command) => command.command));
    const contextCommands = new Set((pkg.contributes?.menus?.['editor/context'] ?? []).map((item) => item.command));
    const palette = new Map((pkg.contributes?.menus?.commandPalette ?? []).map((item) => [item.command, item]));

    expect(commands.has('co.verilog.openIsimWaveform')).toBe(true);
    expect(commands.has('co.verilog.exportVcd')).toBe(true);
    expect(contextCommands.has('co.verilog.openIsimWaveform')).toBe(false);
    expect(contextCommands.has('co.verilog.exportVcd')).toBe(false);
    expect(palette.get('co.verilog.openIsimWaveform')?.when).toBe('false');
    expect(palette.get('co.verilog.exportVcd')?.when).toBe('false');
  });

  it('gates Verilog editor menus by Verilog profiles', () => {
    const pkg = readPackage();
    const menuItems = [
      ...(pkg.contributes?.menus?.['editor/title'] ?? []),
      ...(pkg.contributes?.menus?.['editor/context'] ?? [])
    ].filter((item) => item.command.startsWith('co.verilog.'));

    expect(menuItems.length).toBeGreaterThan(0);
    for (const item of menuItems) {
      expect(item.when, item.command).toContain('co.hasVerilogProfile');
    }
  });

  it('contributes the ASM case index command', () => {
    const pkg = readPackage();
    const commands = new Set((pkg.contributes?.commands ?? []).map((command) => command.command));
    const commandPalette = new Set((pkg.contributes?.menus?.commandPalette ?? []).map((item) => item.command));
    const activationEvents = new Set(pkg.activationEvents ?? []);

    expect(commands.has('co.test.openAsmCaseIndex')).toBe(true);
    expect(commandPalette.has('co.test.openAsmCaseIndex')).toBe(true);
    expect(activationEvents.has('onCommand:co.test.openAsmCaseIndex')).toBe(true);
  });

  it('hides the Verilog signal view outside Verilog signal contexts', () => {
    const pkg = readPackage();
    const signalView = Object.values(pkg.contributes?.views ?? {})
      .flat()
      .find((view) => view.id === 'coVerilogSignal');

    expect(signalView?.when).toContain('co.activeCoKind == verilog');
    expect(signalView?.when).toContain('co.verilogSignalVisible');
  });

  it('keeps CO settings grouped and aligned with runtime defaults', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const properties = Object.assign({}, ...groups.map((group) => group.properties ?? {}));

    expect(groups.map((group) => group.title)).toEqual([
      'BUAA CO: 基础',
      'BUAA CO: 工具链',
      'BUAA CO: 运行与测试',
      'BUAA CO: 编辑器与诊断'
    ]);
    expect(Object.keys(properties)).toHaveLength(62);
    expect(properties['co.test.builtinGenerator.instructionCount'].default).toBe(4000);
    expect(properties['co.test.continuousRetainedPassingCases'].default).toBe(20);
    expect(properties['co.test.continuousReportRetainedIterations'].default).toBe(200);
    expect(properties['co.test.p7.stressMode'].default).toBe('anchor');
    expect(properties['co.test.p7.probeScenarioCount'].default).toBe(32);
    expect(properties['co.verilog.lint.disabledRules'].default).toEqual([...defaultDisabledVerilogLintRules]);
  });

  it('does not provide XML editor support for Logisim .circ files', () => {
    const pkg = readPackage();
    const logisimLanguage = (pkg.contributes?.languages ?? []).find((language) =>
      language.id === 'logisim-circ' || language.extensions?.includes('.circ')
    );
    const logisimGrammar = (pkg.contributes?.grammars ?? []).find((grammar) =>
      grammar.language === 'logisim-circ' || grammar.scopeName === 'text.xml.logisim'
    );

    expect(logisimLanguage).toBeUndefined();
    expect(logisimGrammar).toBeUndefined();
  });

  it('does not hard-code global semantic token colors', () => {
    const pkg = readPackage();
    const defaults = JSON.stringify(pkg.contributes?.configurationDefaults ?? {});
    expect(defaults).not.toContain('semanticTokenColorCustomizations');
    expect(pkg.contributes?.configurationDefaults?.['editor.semanticHighlighting.enabled']).toBeUndefined();
  });

  it('enables semantic highlighting by default for CO languages only', () => {
    const pkg = readPackage();
    expect(pkg.contributes?.configurationDefaults?.['[mipsasm]']).toEqual(expect.objectContaining({
      'editor.semanticHighlighting.enabled': true
    }));
    expect(pkg.contributes?.configurationDefaults?.['[verilog]']).toEqual(expect.objectContaining({
      'editor.semanticHighlighting.enabled': true
    }));
  });

  it('declares theme fallback scopes for every semantic token type', () => {
    const pkg = readPackage();
    const tokenTypes = pkg.contributes?.semanticTokenTypes ?? [];
    const scopeMap = new Map<string, string[]>();
    for (const entry of pkg.contributes?.semanticTokenScopes ?? []) {
      for (const [selector, scopes] of Object.entries(entry.scopes ?? {})) {
        scopeMap.set(selector, scopes);
      }
    }

    expect(tokenTypes.length).toBeGreaterThan(0);
    for (const token of tokenTypes) {
      expect(token.superType, token.id).toBeTruthy();
      expect(scopeMap.get(token.id), token.id).toEqual(expect.arrayContaining([expect.any(String)]));
    }
  });

  it('keeps automatic semantic color presets aligned with declared token types', () => {
    const pkg = readPackage();
    const tokenIds = (pkg.contributes?.semanticTokenTypes ?? []).map((token) => token.id).sort();
    expect([...semanticColorTokenIds].sort()).toEqual(tokenIds);
    expect(Object.keys(semanticColorPresets.dark).sort()).toEqual(tokenIds);
    expect(Object.keys(semanticColorPresets.light).sort()).toEqual(tokenIds);
  });

  it('keeps TextMate grammar coverage for basic highlighting without semantic tokens', () => {
    const mipsGrammar = readJsonFile<{ repository?: Record<string, unknown> }>('syntaxes/mips.tmLanguage.json');
    const verilogGrammar = readJsonFile<{ repository?: Record<string, unknown> }>('syntaxes/verilog.tmLanguage.json');
    const mipsScopes = JSON.stringify(mipsGrammar.repository ?? {});
    const verilogScopes = JSON.stringify(verilogGrammar.repository ?? {});

    expect(mipsScopes).toContain('keyword.control.instruction.mips');
    expect(mipsScopes).toContain('variable.language.register.mips');
    expect(mipsScopes).toContain('keyword.directive.mips');
    expect(verilogScopes).toContain('keyword.control.verilog');
    expect(verilogScopes).toContain('support.function.system-task.verilog');
    expect(verilogScopes).toContain('constant.numeric.verilog');
  });
});
