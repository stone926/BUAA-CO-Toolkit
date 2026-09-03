import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { getConfigDefaults } from '../configDefaults';
import { getCourseConfig } from '../courseConfig';
import { generatorInstructionCatalog } from '../courseTesting/generatorInstructionCatalog';
import { Commands } from '../constants';
import { mipsSemanticTokenTypes } from '../language/mips/resources';
import { verilogSemanticTokenTypes } from '../language/verilog/model';

interface PackageJson {
  activationEvents?: string[];
  contributes?: {
    commands?: Array<{ command: string; title?: string }>;
    configuration?: Array<{
      title: string;
      order?: number;
      properties?: Record<string, {
        default?: unknown;
        deprecationMessage?: string;
        description?: string;
        markdownDescription?: string;
        type?: string;
        enum?: unknown[];
        enumDescriptions?: string[];
        minimum?: number;
        maximum?: number;
        items?: { type?: string; enum?: unknown[] };
        order?: number;
        scope?: string;
      }>;
    }>;
    configurationDefaults?: Record<string, unknown>;
    grammars?: Array<{ language: string; scopeName?: string; path?: string }>;
    languages?: Array<{ id: string; extensions?: string[]; configuration?: string }>;
    menus?: Record<string, Array<{ command: string; when?: string }>>;
    semanticTokenScopes?: Array<{ scopes?: Record<string, string[]> }>;
    semanticTokenTypes?: Array<{ id: string; superType?: string }>;
    views?: Record<string, Array<{ id: string; when?: string }>>;
  };
}

const publicConfigurationGroups = [
  {
    title: '课程项目',
    order: 10,
    scope: 'resource',
    keys: [
      'co.project.profile',
      'co.test.instructions'
    ]
  },
  {
    title: '外部工具',
    order: 20,
    scope: 'machine-overridable',
    keys: [
      'co.toolchain.java',
      'co.toolchain.python',
      'co.toolchain.mars',
      'co.toolchain.logisim',
      'co.toolchain.isePath',
      'co.toolchain.hazardCalculator'
    ]
  },
  {
    title: '编辑器体验',
    order: 30,
    scope: 'resource',
    keys: [
      'co.mips.warnPseudoInstruction',
      'co.mips.instructionTokenMode',
      'co.mips.warnMissingExitSyscall',
      'co.verilog.implicitNet.diagnostic',
      'co.verilog.syntax.external.mode',
      'co.verilog.lint.courseRules',
      'co.verilog.lint.synthesizableHints'
    ]
  },
  {
    title: '高级项目兼容',
    order: 40,
    scope: 'resource',
    keys: [
      'co.project.topModule',
      'co.project.testbench',
      'co.project.machineCode',
      'co.project.simTime',
      'co.run.revealOutput'
    ]
  }
] as const;

const compatibilityConfigurationKeys = [
  'co.toolchain.marsP7',
  'co.mips.engine',
  'co.mips.delayedBranching',
  'co.mips.memoryConfiguration',
  'co.run.showCommandBeforeRun',
  'co.run.timeoutMs',
  'co.mips.extraArgs',
  'co.verilog.syntax.external.timeoutMs',
  'co.verilog.syntax.ise.suppressedWarnings',
  'co.verilog.implicitNet.ignorePatterns',
  'co.verilog.lint.disabledRules',
  'co.diagnostics.disabledCodes',
  'co.diagnostics.disabledFileCodes',
  'co.verilog.format.continuationIndent',
  'co.verilog.format.spaceInRange',
  'co.verilog.format.declarationRangeSpacing',
  'co.verilog.format.spaceBeforeInstancePorts',
  'co.verilog.format.separateElse',
  'co.verilog.format.maxBlankLines',
  'co.verilog.format.alignment.parameter',
  'co.verilog.format.alignment.modulePort',
  'co.verilog.format.alignment.ternary'
] as const;

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

  it('contributes only the continuous-test start, stop, and history facade commands', () => {
    const pkg = readPackage();
    const commandEntries = (pkg.contributes?.commands ?? [])
      .filter((command) => command.command.startsWith('co.test.'));
    const commands = commandEntries.map((command) => command.command);
    const palette = (pkg.contributes?.menus?.commandPalette ?? [])
      .map((item) => item.command)
      .filter((command) => command.startsWith('co.test.'));

    expect(commands).toEqual([
      'co.test.startContinuousGeneratedTraceTests',
      'co.test.stopContinuousTests',
      'co.test.openAsmCaseIndex'
    ]);
    expect(palette).toEqual(commands);
    expect(commandEntries.map((command) => command.title)).toEqual([
      'CO: 启动持续测试',
      'CO: 停止持续测试',
      'CO: 测试历史 / 失败用例'
    ]);
  });

  it('hides the Verilog signal view outside Verilog signal contexts', () => {
    const pkg = readPackage();
    const signalView = Object.values(pkg.contributes?.views ?? {})
      .flat()
      .find((view) => view.id === 'coVerilogSignal');

    expect(signalView?.when).toContain('co.activeCoKind == verilog');
    expect(signalView?.when).toContain('co.verilogSignalVisible');
  });

  it('exposes exactly the ordered 20-setting public surface', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const publicGroups = groups.filter((group) => group.title !== '兼容设置（仅已配置用户可见）');
    const publicProperties = Object.assign({}, ...publicGroups.map((group) => group.properties ?? {}));
    const expectedPublicKeys = publicConfigurationGroups.flatMap((group) => [...group.keys]);

    expect(publicGroups.map((group) => ({ title: group.title, order: group.order }))).toEqual(
      publicConfigurationGroups.map((group) => ({ title: group.title, order: group.order }))
    );
    expect(Object.keys(publicProperties)).toEqual(expectedPublicKeys);
    expect(expectedPublicKeys).toHaveLength(20);

    for (const expectedGroup of publicConfigurationGroups) {
      const actualGroup = publicGroups.find((group) => group.title === expectedGroup.title);
      const actualProperties = actualGroup?.properties ?? {};
      expect(Object.keys(actualProperties), expectedGroup.title).toEqual([...expectedGroup.keys]);
      expectedGroup.keys.forEach((key, index) => {
        expect(actualProperties[key], key).toMatchObject({
          scope: expectedGroup.scope,
          order: (index + 1) * 10
        });
        expect(actualProperties[key]?.deprecationMessage, key).toBeUndefined();
      });
    }

    expect(publicProperties['co.verilog.syntax.external.mode']).toMatchObject({
      type: 'string',
      default: 'onSave',
      enum: ['off', 'onSave', 'commandOnly']
    });
  });

  it('keeps internal defaults as a superset without publishing defaults for compatibility settings', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const properties = Object.assign({}, ...groups.map((group) => group.properties ?? {}));
    const configDefaults = getConfigDefaults();
    const publicKeys = new Set<string>(publicConfigurationGroups.flatMap((group) => [...group.keys]));
    const internalOnlyDefaultKeys = Object.keys(configDefaults)
      .map((key) => `co.${key}`)
      .filter((key) => !publicKeys.has(key));

    expect(Object.keys(configDefaults).length).toBeGreaterThan(publicKeys.size);
    expect(internalOnlyDefaultKeys).toEqual(expect.arrayContaining([...compatibilityConfigurationKeys]));
    expect(internalOnlyDefaultKeys).toHaveLength(compatibilityConfigurationKeys.length);

    for (const key of publicKeys) {
      const defaultKey = key.replace(/^co\./, '');
      const expectedDefault = key === 'co.project.topModule' || key === 'co.project.testbench'
        ? ''
        : configDefaults[defaultKey];
      expect(properties[key]?.default, key).toEqual(expectedDefault);
    }

    expect(properties['co.project.topModule']?.description).toContain('通常无需修改');
    expect(properties['co.project.testbench']?.description).toContain('自动测试使用独立');

    const compatibilityGroup = groups.find((group) => group.title === '兼容设置（仅已配置用户可见）');
    expect(compatibilityGroup?.order).toBe(100);
    expect(Object.keys(compatibilityGroup?.properties ?? {})).toEqual([...compatibilityConfigurationKeys]);
    compatibilityConfigurationKeys.forEach((key, index) => {
      const property = compatibilityGroup?.properties?.[key];
      expect(property?.default, key).toBeUndefined();
      expect(property?.deprecationMessage?.trim().length, key).toBeGreaterThan(0);
      expect(property?.scope, key).toBe(key === 'co.toolchain.marsP7' ? 'machine-overridable' : 'resource');
      expect(property?.order, key).toBe((index + 1) * 10);
    });
  });

  it('derives generator profile descriptions from the ASM generator catalog', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const properties = Object.assign({}, ...groups.map((group) => group.properties ?? {}));
    const property = properties['co.test.instructions'];
    const description = property.description ?? '';
    const markdownDescription = property.markdownDescription ?? '';

    expect(description).toBe('自动测试重点覆盖的真实指令。用逗号或空白分隔；留空时覆盖当前 Profile 的完整课程指令集。测试规模、中断、异常、外设和持续测试策略由插件自动使用最强安全配置。');
    expect(description).not.toContain('P6=');
    expect(markdownDescription).toContain('默认指令集');
    for (const [profile, mnemonics] of Object.entries(generatorInstructionCatalog.profiles)) {
      expect(markdownDescription).toContain(`**${profile}**`);
      expect(markdownDescription).toContain(`\`${mnemonics.join(', ')}\``);
    }
  });

  it('keeps setting descriptions focused on user-facing behavior', () => {
    const pkg = readPackage();
    const groups = pkg.contributes?.configuration ?? [];
    const descriptions = groups.flatMap((group) =>
      Object.entries(group.properties ?? {}).flatMap(([key, property]) => [
        [`${key}.description`, property.description],
        [`${key}.markdownDescription`, property.markdownDescription]
      ])
    );

    for (const [label, description] of descriptions) {
      if (!description) {
        continue;
      }
      expect(description, label).not.toMatch(/resources[\\/]/);
      expect(description, label).not.toMatch(/由 .*(生成|派生)/);
      expect(description, label).not.toContain('派生为');
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

  it('keeps SystemVerilog lexical support separate from the Verilog LSP language id', () => {
    const pkg = readPackage();
    const verilog = pkg.contributes?.languages?.find((language) => language.id === 'verilog');
    const systemVerilog = pkg.contributes?.languages?.find((language) => language.id === 'systemverilog');
    const systemVerilogGrammar = pkg.contributes?.grammars?.find((grammar) => grammar.language === 'systemverilog');

    expect(verilog?.extensions).toEqual(expect.arrayContaining(['.v', '.vh']));
    expect(verilog?.extensions).not.toEqual(expect.arrayContaining(['.sv', '.svh']));
    expect(systemVerilog?.extensions).toEqual(['.sv', '.svh']);
    expect(systemVerilogGrammar?.scopeName).toBe('source.systemverilog.co');
    expect(pkg.contributes?.configurationDefaults?.['[systemverilog]']).toBeUndefined();
  });

  it('does not hard-code global semantic token colors', () => {
    const pkg = readPackage();
    const defaults = JSON.stringify(pkg.contributes?.configurationDefaults ?? {});
    const properties = Object.assign({}, ...(pkg.contributes?.configuration ?? []).map((group) => group.properties ?? {}));
    const semanticContributions = JSON.stringify({
      types: pkg.contributes?.semanticTokenTypes,
      scopes: pkg.contributes?.semanticTokenScopes
    });
    expect(defaults).not.toContain('semanticTokenColorCustomizations');
    expect(pkg.contributes?.configurationDefaults?.['editor.semanticHighlighting.enabled']).toBeUndefined();
    expect(properties).not.toHaveProperty('co.semanticColors.preset');
    expect(readJsonFile<Record<string, unknown>>('resources/co/configDefaults.json')).not.toHaveProperty('semanticColors.preset');
    expect(semanticContributions).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(semanticContributions).not.toContain('foreground');
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

  it('keeps the LSP semantic token legend aligned with declared token types', () => {
    const pkg = readPackage();
    const tokenIds = (pkg.contributes?.semanticTokenTypes ?? []).map((token) => token.id).sort();
    expect([...mipsSemanticTokenTypes, ...verilogSemanticTokenTypes].sort()).toEqual(tokenIds);
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
