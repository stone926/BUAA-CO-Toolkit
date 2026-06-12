import { describe, expect, it } from 'vitest';
import { defaultCoSettings } from '../language/common/settings';
import { applyResolvedProfile, resolveProjectProfile, ProfileResolverModule } from '../profileResolver';

function module(name: string, ports: string[], bodyText = ''): ProfileResolverModule {
  return {
    name,
    ports: ports.map((port) => ({ name: port })),
    bodyText
  };
}

describe('profile resolver', () => {
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
});

function p6Ports(): string[] {
  return [
    'clk',
    'reset',
    'i_inst_rdata',
    'm_data_rdata',
    'i_inst_addr',
    'm_data_addr',
    'm_data_wdata',
    'm_data_byteen',
    'm_inst_addr',
    'w_grf_addr',
    'w_grf_wdata',
    'w_grf_we',
    'w_inst_addr'
  ];
}

function p7Ports(): string[] {
  return [
    ...p6Ports(),
    'interrupt',
    'macroscopic_pc',
    'm_int_addr',
    'm_int_byteen'
  ];
}
