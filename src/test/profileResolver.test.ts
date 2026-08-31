import { describe, expect, it } from 'vitest';
import { defaultCoSettings, mergeCoSettings } from '../language/common/settings';
import { applyResolvedProfile, resolveProjectProfile, ProfileResolverModule } from '../profileResolver';
import { getProfileInferenceConfig } from '../courseConfig';

function module(name: string, ports: string[], bodyText = ''): ProfileResolverModule {
  return {
    name,
    ports: ports.map((port) => ({ name: port })),
    bodyText
  };
}

describe('profile resolver', () => {
  it('loads inference hints from the course configuration resource', () => {
    const hints = getProfileInferenceConfig();
    expect(hints.topModuleNames).toEqual(expect.arrayContaining(['mips', 'cpu']));
    expect(hints.p6RequiredPorts?.length).toBeGreaterThan(0);
    expect(hints.p7ExclusivePorts?.length).toBeGreaterThan(0);
    expect(hints.p7Structure?.cp0DeclarationHints?.length).toBeGreaterThan(0);
    expect(hints.logisimCpuPathPatterns?.length).toBeGreaterThan(0);
  });

  it('uses explicit concrete profiles before inference', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'P5',
      configuredSource: 'settings',
      topModule: 'mips',
      modules: [module('mips', p7Ports())]
    });

    expect(result.effectiveProfile).toBe('P5');
    expect(result.source).toBe('settings');
    expect(result.confidence).toBe('explicit');
  });

  it('infers P7 from top-level interrupt and peripheral ports', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      topModule: 'mips',
      modules: [module('mips', p7Ports())]
    });

    expect(result.effectiveProfile).toBe('P7');
  });

  it('infers P6 from the external memory interface without P7-only ports', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      topModule: 'mips',
      modules: [module('mips', p6Ports())]
    });

    expect(result.effectiveProfile).toBe('P6');
  });

  it('infers P4 from clk/reset top and trace display without timestamp', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      topModule: 'mips',
      modules: [module('mips', ['clk', 'reset'], 'always @(*) $display("@%h: $%d <= %h", pc, addr, data);')]
    });

    expect(result.effectiveProfile).toBe('P4');
  });

  it('infers P5 from clk/reset top and trace display with timestamp', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      topModule: 'mips',
      modules: [module('mips', ['clk', 'reset'], 'always @(*) $display("%0d@%08h: $%0d <= %08h", $time, pc, addr, data);')]
    });

    expect(result.effectiveProfile).toBe('P5');
  });

  it('infers P7 from course-configured structure hints', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      modules: [
        module('mips', ['clk', 'reset']),
        {
          name: 'MyCP0',
          ports: [],
          declarations: new Map([
            ['SR', { name: 'SR' }],
            ['Cause', { name: 'Cause' }],
            ['EPC', { name: 'EPC' }]
          ])
        },
        module('Bridge', []),
        module('TC', [])
      ]
    });

    expect(result.effectiveProfile).toBe('P7');
  });

  it('uses precomputed Verilog display formats without requiring full source text', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      topModule: 'mips',
      modules: [module('mips', ['clk', 'reset'])],
      verilogDisplayFormats: ['%0d@%08h: $%0d <= %08h']
    });

    expect(result.effectiveProfile).toBe('P5');
  });

  it('does not guess P4 or P5 when clk/reset top has no trace display', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      topModule: 'mips',
      modules: [module('mips', ['clk', 'reset'])]
    });

    expect(result.effectiveProfile).toBeUndefined();
    expect(result.confidence).toBe('none');
  });

  it('does not guess P4 or P5 when trace display evidence is mixed', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      topModule: 'mips',
      modules: [
        module('mips', ['clk', 'reset'], [
          '$display("@%h: $%d <= %h", pc, addr, data);',
          '$display("%d@%h: $%d <= %h", $time, pc, addr, data);'
        ].join('\n'))
      ]
    });

    expect(result.effectiveProfile).toBeUndefined();
  });

  it('infers P2 for ASM-only context', () => {
    const result = resolveProjectProfile({
      configuredProfile: 'auto',
      activeLanguageId: 'mipsasm',
      activeFilePath: 'E:/co/p2/src/matrix.asm',
      files: [{ path: 'E:/co/p2/src/matrix.asm', languageId: 'mipsasm' }]
    });

    expect(result.effectiveProfile).toBe('P2');
  });

  it('infers P0 and P3 for Logisim contexts conservatively', () => {
    expect(resolveProjectProfile({
      configuredProfile: 'auto',
      activeFilePath: 'E:/co/p0/circuit.circ',
      files: [{ path: 'E:/co/p0/circuit.circ', languageId: 'logisim-circ' }]
    }).effectiveProfile).toBe('P0');

    expect(resolveProjectProfile({
      configuredProfile: 'auto',
      activeFilePath: 'E:/co/p3/cpu.circ',
      files: [
        { path: 'E:/co/p3/cpu.circ', languageId: 'logisim-circ' },
        { path: 'E:/co/p3/test/case.asm', languageId: 'mipsasm' }
      ]
    }).effectiveProfile).toBe('P3');
  });

  it('applies inferred concrete profiles to LSP settings but leaves unresolved auto alone', () => {
    const inferred = applyResolvedProfile(defaultCoSettings, {
      modules: [module('mips', p7Ports())]
    });
    expect(inferred.project.profile).toBe('P7');

    const unresolved = applyResolvedProfile(defaultCoSettings, {
      modules: [module('mips', ['clk', 'reset'])]
    });
    expect(unresolved.project.profile).toBe('auto');
  });

  it('applies P1 entrypoint defaults after auto inference without replacing explicit overrides', () => {
    const inferred = applyResolvedProfile(mergeCoSettings({
      project: { profile: 'auto', topModule: '', testbench: '' }
    }), {
      files: [{ path: 'E:/co/p1/main.v', languageId: 'verilog' }],
      modules: [module('main', [])]
    });
    expect(inferred.project).toMatchObject({
      profile: 'P1',
      topModule: 'main',
      testbench: 'main_tb'
    });

    const customized = applyResolvedProfile(mergeCoSettings({
      project: { profile: 'auto', topModule: 'custom_top', testbench: 'custom_tb' }
    }), {
      files: [{ path: 'E:/co/p1/custom_top.v', languageId: 'verilog' }],
      modules: [module('custom_top', [])]
    });
    expect(customized.project).toMatchObject({
      profile: 'P1',
      topModule: 'custom_top',
      testbench: 'custom_tb'
    });
  });
});

function p6Ports(): string[] {
  return [...(getProfileInferenceConfig().p6RequiredPorts ?? [])];
}

function p7Ports(): string[] {
  return [
    ...p6Ports(),
    ...(getProfileInferenceConfig().p7ExclusivePorts ?? [])
  ];
}
