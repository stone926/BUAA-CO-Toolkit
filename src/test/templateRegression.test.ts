import { describe, expect, it } from 'vitest';
import { defaultCoSettings } from '../language/common/settings';
import { buildTestbench, parseVerilog } from '../language/verilog/service';
import { getVerilogTestbenchConfig } from '../courseConfig';
import { verilogDoc } from './helpers/textDocument';

function moduleFrom(text: string) {
  const parsed = parseVerilog(verilogDoc(text), defaultCoSettings, false);
  const [module] = parsed.modules;
  expect(module).toBeDefined();
  return module!;
}

describe('testbench template regression contracts', () => {
  it('uses armed P7 probe metadata without enabling the legacy external raise block', () => {
    const module = moduleFrom('module mips(input clk, input reset); endmodule');
    const text = buildTestbench(module, 'mips_tb', {
      profile: 'P7',
      p7Probe: {
        scenarios: [
          { id: 1, kind: 'external', waitPc: 0x3020, armAddress: 0x27d0, armValue: 1, externalDelayCycles: 4 }
        ]
      }
    });

    expect(text).toContain('CO_P7_PROBE external_arm');
    expect(text).toContain('co_p7_external_armed && fixed_macroscopic_pc == co_p7_external_target');
    expect(text).not.toContain('co_p7_external_legacy && fixed_macroscopic_pc == co_p7_external_target');
  });

  it('keeps the legacy P7 external raise block only for legacy probe metadata', () => {
    const module = moduleFrom('module mips(input clk, input reset); endmodule');
    const text = buildTestbench(module, 'mips_tb', {
      profile: 'P7',
      p7Probe: {
        scenarios: [
          { id: 1, kind: 'external', waitPc: 0x3020 }
        ]
      }
    });

    expect(text).toContain('co_p7_external_legacy = 1;');
    expect(text).toContain('co_p7_external_legacy && fixed_macroscopic_pc == co_p7_external_target');
    expect(text).not.toContain('CO_P7_PROBE external_arm');
  });

  it('derives non-P7 external memory depth from courseConfig instead of hard-coded P7 capacity', () => {
    const module = moduleFrom(`
module mips(
    input clk,
    input reset,
    output [31:0] i_inst_addr,
    input [31:0] i_inst_rdata,
    output [31:0] m_data_addr,
    input [31:0] m_data_rdata,
    output [31:0] m_data_wdata,
    output [3:0] m_data_byteen
);
endmodule
`.trim());
    const { externalInstructionMemoryWords, externalDataMemoryWords } = getVerilogTestbenchConfig();
    const text = buildTestbench(module, 'mips_tb', { profile: 'P6' });

    expect(text).toContain(`reg [31:0] inst[0:${externalInstructionMemoryWords - 1}];`);
    expect(text).toContain(`reg [31:0] data[0:${externalDataMemoryWords - 1}];`);
    expect(text).toContain(`for (i = 0; i < ${externalDataMemoryWords}; i = i + 1) begin`);
  });
});
