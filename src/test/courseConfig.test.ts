import { describe, expect, it } from 'vitest';
import {
  getCourseConfig,
  getProfileDirectories,
  getProfileRequiredTools,
  getVerilogPorts
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

  it('contains tutorial links for profiles and core tools', () => {
    const tutorial = getCourseConfig().tutorial;
    expect(tutorial?.profiles?.P7?.path).toBe('P7/implement/P7-2-1/');
    expect(tutorial?.tools?.logisim?.length).toBeGreaterThan(0);
    expect(tutorial?.tools?.mars?.length).toBeGreaterThan(0);
    expect(tutorial?.tools?.ise?.length).toBeGreaterThan(0);
  });
});
