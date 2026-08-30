import { describe, expect, it } from 'vitest';
import {
  getLogisimTraceProfileConfig,
  getProfileDefaults,
  getProfileDirectories,
  getProfileInferenceConfig,
  getProfileRequiredTools,
  getVerilogTestbenchConfig,
  getVerilogPorts,
  profilesWithCapability
} from '../courseConfig';

describe('course config alignment', () => {
  it('uses the bundled-capable simulator dependency for P1', () => {
    expect(getProfileDirectories('P1')).toEqual(['.co', 'src', 'test', 'sim']);
    expect(getProfileRequiredTools('P1')).toEqual(['verilogSimulator']);
  });

  it('keeps legacy-only tools on P0-P3 where their profile capability still needs them', () => {
    expect(getProfileRequiredTools('P0')).toEqual(['logisim', 'java']);
    expect(getProfileRequiredTools('P2')).toEqual(['mars', 'java']);
    expect(getProfileRequiredTools('P3')).toEqual(['logisim', 'java']);
  });

  it('uses one logical Verilog simulator dependency for P4-P7 course paths', () => {
    expect(getProfileRequiredTools('P4')).toEqual(['verilogSimulator']);
    expect(getProfileRequiredTools('P5')).toEqual(['verilogSimulator']);
    expect(getProfileRequiredTools('P6')).toEqual(['verilogSimulator']);
    expect(getProfileRequiredTools('P7')).toEqual(['verilogSimulator']);
  });

  it('matches the tutorial P5 top-level interface', () => {
    expect(getVerilogPorts('P5').map((port) => port.name)).toEqual(['clk', 'reset']);
  });

  it('exposes profile capabilities from course config', () => {
    expect(profilesWithCapability('trace')).toEqual(['P3', 'P4', 'P5', 'P6', 'P7']);
    expect(profilesWithCapability('verilog')).toEqual(['P1', 'P4', 'P5', 'P6', 'P7']);
    expect(profilesWithCapability('mips')).toEqual(['P2', 'P4', 'P5', 'P6', 'P7']);
    expect(profilesWithCapability('hazard')).toEqual(['P5', 'P6', 'P7']);
  });

  it('exposes project defaults for Verilog profiles', () => {
    expect(getProfileDefaults('P1')).toEqual(expect.objectContaining({
      topModule: 'main',
      testbench: 'main_tb'
    }));
    expect(getProfileDefaults('P7')).toEqual(expect.objectContaining({
      topModule: 'mips',
      testbench: 'mips_tb',
      machineCode: 'code.txt'
    }));
  });

  it('exposes the P3 Logisim trace profile as course data', () => {
    const profile = getLogisimTraceProfileConfig('P3');
    expect(profile?.defaultCircuit).toBe('main');
    expect(profile?.textBase).toBe('0x00003000');
    expect(profile?.romMaxWords).toBe(4096);
    expect(profile?.haltLoopWords).toBe(2);
    expect(profile?.orderedColumns).toEqual([
      'instr',
      'pc',
      'regwrite',
      'regaddr',
      'regdata',
      'memwrite',
      'memaddr',
      'memdata'
    ]);
    expect(profile?.columns.regaddr.width).toBe(5);
  });

  it('keeps tutorial IM and DM capacities distinct', () => {
    expect(getVerilogTestbenchConfig()).toEqual({
      externalInstructionMemoryWords: 4096,
      externalDataMemoryWords: 3072
    });
  });

  it('exposes profile inference hints as course data', () => {
    const inference = getProfileInferenceConfig();
    expect(inference.topModuleNames).toContain('mips');
    expect(inference.p6RequiredPorts).toContain('i_inst_rdata');
    expect(inference.p7ExclusivePorts).toContain('macroscopic_pc');
    expect(inference.p7Structure?.bridgeModuleNames).toContain('bridge');
    expect(inference.logisimCpuPathPatterns?.length).toBeGreaterThan(0);
  });
});
