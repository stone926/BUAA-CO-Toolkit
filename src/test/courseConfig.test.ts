import { describe, expect, it } from 'vitest';
import {
  getCourseConfig,
  getProfileDefaults,
  getProfileDirectories,
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

  it('contains tutorial links for profiles and core tools', () => {
    const tutorial = getCourseConfig().tutorial;
    expect(tutorial?.profiles?.P7?.path).toBe('P7/implement/P7-2-1/');
    expect(tutorial?.tools?.logisim?.length).toBeGreaterThan(0);
    expect(tutorial?.tools?.mars?.length).toBeGreaterThan(0);
    expect(tutorial?.tools?.ise?.length).toBeGreaterThan(0);
  });
});
