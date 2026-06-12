import { describe, expect, it } from 'vitest';
import {
  buildIseProjectText,
  buildIsimRunTcl,
  buildIsimVcdTcl,
  buildIsimWaveTcl,
  generatedRuntimeTestbenchText,
  generatedTestbenchMarker,
  isGeneratedRuntimeTestbench,
  p7AutoRuntimeTestbenchName,
  runtimeTestbenchFileName,
  verilogProjectExcludeGlob
} from '../verilogSimulationFiles';

describe('verilog simulation file helpers', () => {
  it('uses stable runtime testbench names', () => {
    expect(runtimeTestbenchFileName('mips_tb')).toBe('co_generated_mips_tb.v');
    expect(runtimeTestbenchFileName('cpu tb')).toBe('co_generated_cpu_tb.v');
    expect(p7AutoRuntimeTestbenchName).toBe('co_generated_p7_auto_tb');
  });

  it('marks generated runtime testbenches', () => {
    const text = generatedRuntimeTestbenchText('module mips_tb; endmodule\n');
    expect(text).toContain(generatedTestbenchMarker);
    expect(isGeneratedRuntimeTestbench(text)).toBe(true);
    expect(isGeneratedRuntimeTestbench('module user_tb; endmodule\n')).toBe(false);
  });

  it('builds deterministic ISE project files from explicit source lists', () => {
    expect(verilogProjectExcludeGlob).toContain('.co');
    const prj = buildIseProjectText([
      'E:\\work\\src\\mips.v',
      'E:\\work\\.co\\isim\\co_generated_mips_tb.v'
    ]);
    expect(prj).toBe([
      'Verilog work "E:/work/.co/isim/co_generated_mips_tb.v"',
      'Verilog work "E:/work/src/mips.v"',
      ''
    ].join('\n'));
  });

  it('builds run, GUI wave, and VCD Tcl scripts', () => {
    expect(buildIsimRunTcl('200us')).toBe('run 200us;\nexit\n');
    expect(buildIsimWaveTcl('200us')).toContain('wave add -r /');
    const vcd = buildIsimVcdTcl('E:\\work\\.co\\out\\mips tb.vcd', 'mips_tb', '200us');
    expect(vcd).toContain('vcd dumpfile "E:/work/.co/out/mips tb.vcd"');
    expect(vcd).toContain('vcd dumpvars -m /mips_tb -l 0');
    expect(vcd).toContain('vcd dumpflush');
    expect(vcd).toContain('quit');
  });
});
