import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import {
  semanticColorPresets,
  semanticColorTokenIds
} from '../semanticColorPresets';
import { defaultDisabledVerilogLintRules } from '../language/common/settings';
import { getConfigDefaults } from '../configDefaults';
import { getCourseConfig, getLogisimTraceProfileConfig } from '../courseConfig';
import { generatorInstructionCatalog } from '../courseTesting/generatorInstructionCatalog';
import {
  p7CourseInstructionCountMaximum,
  p7ExceptionHandlerAddress,
  p7ProbeDefaultScenarioCount,
  p7ProbeMaxScenarioCount
} from '../courseTesting/p7Hardware';
import {
  configurableVerilogLintRuleIds,
  defaultDisabledVerilogLintRuleIds
} from '../language/verilog/lintRuleCatalog';
import { Commands } from '../constants';

interface PackageJson {
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string }>;
    configuration?: Array<{ title: string; properties?: Record<string, { default?: unknown; description?: string; enum?: unknown[]; enumDescriptions?: string[]; minimum?: number; maximum?: number; items?: { enum?: unknown[] } }> }>;
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

function commandValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.values(value).flatMap((entry) => commandValues(entry));
}

describe('package manifest', () => {
  it('keeps generated configuration schema in sync with resource sources', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-manifest-config.mjs', '--check'], {
      cwd: process.cwd(),
      stdio: 'pipe'
    })).not.toThrow();
  });

  it('keeps activation events limited to non-auto workspace triggers', () => {
    const pkg = readPackage();
    expect(pkg.activationEvents).toEqual(['workspaceContains:**/*.circ']);
    expect(pkg.activationEvents?.some((event) =>
      event.startsWith('onCommand:')
      || event.startsWith('onLanguage:')
      || event.startsWith('onView:')
    )).toBe(false);
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

  it('keeps contributed commands declared in the command source and attached to manifest UI surfaces', () => {
    const pkg = readPackage();
    const sourceCommands = new Set(commandValues(Commands));
    const allMenuCommands = new Set(
      Object.values(pkg.contributes?.menus ?? {})
        .flat()
        .map((item) => item.command)
    );

    for (const { command } of pkg.contributes?.commands ?? []) {
      expect(sourceCommands.has(command), command).toBe(true);
      expect(allMenuCommands.has(command), command).toBe(true);
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
    expect(activationEvents.has('onCommand:co.test.openAsmCaseIndex')).toBe(false);
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
    const configDefaults = getConfigDefaults();

    expect(groups.map((group) => group.title)).toEqual([
      '项目基本情况',
      '工具链',
      '运行与测试',
      '编辑器与诊断'
    ]);
    expect(Object.keys(properties)).toHaveLength(64);
    expect(Object.keys(configDefaults)).toHaveLength(64);
    for (const [key, value] of Object.entries(configDefaults)) {
      expect(properties[`co.${key}`]?.default, key).toEqual(value);
    }
    for (const key of Object.keys(properties)) {
      expect(configDefaults[key.replace(/^co\./, '')], key).not.toBeUndefined();
    }
    expect(properties['co.test.builtinGenerator.instructionCount'].default).toBe(4000);
    expect(properties['co.test.continuousRetainedPassingCases'].default).toBe(20);
    expect(properties['co.test.continuousReportRetainedIterations'].default).toBe(200);
    expect(properties['co.test.p7.stressMode'].default).toBe('anchor');
    expect(properties['co.test.p7.probeScenarioCount'].default).toBe(p7ProbeDefaultScenarioCount);
    expect(properties['co.test.p7.probeScenarioCount'].maximum).toBe(p7ProbeMaxScenarioCount);
    expect(properties['co.verilog.lint.disabledRules'].default).toEqual([...defaultDisabledVerilogLintRules]);
    expect(properties['co.verilog.lint.disabledRules'].default).toEqual(defaultDisabledVerilogLintRuleIds);
    expect(properties['co.verilog.lint.disabledRules'].items?.enum).toEqual(configurableVerilogLintRuleIds);
    expect(properties['co.test.logisim.mainCircuit'].default).toBe(getLogisimTraceProfileConfig('P3')?.defaultCircuit);

    const propertyKeys = Object.keys(properties);
    const alignmentStart = propertyKeys.indexOf('co.verilog.format.alignment.parameter');
    expect(propertyKeys.slice(alignmentStart, alignmentStart + 3)).toEqual([
      'co.verilog.format.alignment.parameter',
      'co.verilog.format.alignment.modulePort',
      'co.verilog.format.alignment.ternary'
    ]);
  });

  it('derives P7 manifest limits and descriptions from the hardware resource', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const properties = Object.assign({}, ...groups.map((group) => group.properties ?? {}));
    const p7InstructionCount = properties['co.test.builtinGenerator.p7InstructionCount'];
    const handler = `0x${p7ExceptionHandlerAddress.toString(16)}`;

    expect(p7InstructionCount.default).toBe(p7CourseInstructionCountMaximum);
    expect(p7InstructionCount.maximum).toBe(p7CourseInstructionCountMaximum);
    expect(p7InstructionCount.description).toContain(handler);
    expect(p7InstructionCount.description).toContain(String(p7CourseInstructionCountMaximum));
    expect(properties['co.toolchain.marsP7'].description).toContain(handler);
    expect(properties['co.mips.memoryConfiguration'].description).toContain(handler);
  });

  it('derives generator profile descriptions from the ASM generator catalog', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const properties = Object.assign({}, ...groups.map((group) => group.properties ?? {}));
    const description = properties['co.test.builtinGenerator.instructions'].description ?? '';

    for (const [profile, mnemonics] of Object.entries(generatorInstructionCatalog.profiles)) {
      expect(description).toContain(`${profile}=${mnemonics.join(', ')}`);
    }
  });

  it('keeps the project profile enum aligned with course config profiles', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const properties = Object.assign({}, ...groups.map((group) => group.properties ?? {}));
    const profileEnum = properties['co.project.profile']?.enum ?? [];
    const profileNames = Object.values(getCourseConfig().profiles).map((profile) => profile.name);
    expect(profileEnum).toEqual(['auto', ...Object.keys(getCourseConfig().profiles)]);
    expect(properties['co.project.profile']?.enumDescriptions?.slice(1)).toEqual(profileNames);
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
