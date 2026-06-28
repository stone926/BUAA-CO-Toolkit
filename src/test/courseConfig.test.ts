import { describe, expect, it } from 'vitest';
import {
  getCourseConfig,
  getLogisimTraceProfileConfig,
  getProfileDefaults,
  getProfileDirectories,
  getProfileInferenceConfig,
  getProfileRequiredTools,
  getVerilogPorts,
  profilesWithCapability
} from '../courseConfig';

describe('course config alignment', () => {
  it('uses ISE-oriented directories and tools for P1', () => {
    expect(getProfileDirectories('P1')).toEqual(['.co', 'src', 'test', 'sim']);
    expect(getProfileRequiredTools('P1')).toEqual(['ise']);
  });

  it('uses Logisim and MARS tools only for the matching profiles', () => {
    expect(getProfileRequiredTools('P0')).toEqual(['logisim', 'java']);
    expect(getProfileRequiredTools('P2')).toEqual(['mars', 'java']);
    expect(getProfileRequiredTools('P3')).toEqual(['logisim', 'java']);
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
      machineCode: 'code.txt',
      simBackend: 'isim'
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

  it('exposes profile inference hints as course data', () => {
    const inference = getProfileInferenceConfig();
    expect(inference.topModuleNames).toContain('mips');
    expect(inference.p6RequiredPorts).toContain('i_inst_rdata');
    expect(inference.p7ExclusivePorts).toContain('macroscopic_pc');
    expect(inference.p7Structure?.bridgeModuleNames).toContain('bridge');
    expect(inference.logisimCpuPathPatterns?.length).toBeGreaterThan(0);
  });

  it('contains tutorial links for profiles and core tools', () => {
    const tutorial = getCourseConfig().tutorial;
    expect(tutorial?.profiles?.P7?.path).toBe('P7/implement/P7-2-1/');
    expect(tutorial?.tools?.logisim?.length).toBeGreaterThan(0);
    expect(tutorial?.tools?.mars?.length).toBeGreaterThan(0);
    expect(tutorial?.tools?.ise?.length).toBeGreaterThan(0);
  });
});
