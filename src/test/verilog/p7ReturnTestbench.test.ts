import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildP7ReturnInterruptBlock } from '../../language/verilog/p7ReturnTestbench';
import { buildIverilogEnvironment, buildIverilogRuntimeArgs, resolveIverilogRuntime } from '../../verilog/iverilogRuntime';

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../..'));
const available = fs.existsSync(runtime.iverilogPath) && fs.existsSync(runtime.vvpPath);
const scenarios = [
  { id: 1, kind: 'external', triggerPc: 0x3040, armAddress: 0x27d0, armValue: 1 },
  { id: 2, kind: 'external', afterReturnOf: { scenarioId: 1, eretPc: 0x41c4 } }
];

describe.skipIf(!available)('public return-boundary protocol in real Icarus', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-return-protocol-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function run(mode: 'short' | 'stalled' | 'unaligned' | 'unknown' | 'low-address-bits' | 'wrong-ack' | 'forwarded-unselected' | 'request-gated-ack') {
    const source = `\`timescale 1ns/1ps
module tb;
reg clk=0, reset=1, interrupt=0; always #2 clk=~clk;
reg [31:0] macroscopic_pc=32'h3000,m_data_addr=0,m_data_wdata=0,m_inst_addr=0,m_int_addr=0;
reg [3:0] m_data_byteen=0,int_mask=0;
wire [3:0] m_int_byteen=${mode === 'request-gated-ack' ? '(interrupt ? int_mask : 0)' : 'int_mask'};
wire [31:0] fixed_addr=m_data_addr & 32'hfffffffc;
${buildP7ReturnInterruptBlock(scenarios, 0x41c0)}
task tick; begin @(posedge clk); #1; end endtask
initial begin
 tick; tick; reset=0;
 m_inst_addr=32'h3030;m_data_addr=${mode === 'low-address-bits' ? "{30'h9f4,2'bxx}" : "32'h27d0"};m_data_wdata=1;m_data_byteen=15;
 ${mode === 'forwarded-unselected' ? "m_int_addr=32'h27d0;int_mask=15;" : ''}
 tick; m_data_byteen=0;macroscopic_pc=32'h3040;
 tick; if(!interrupt)$fatal(1,"first request missing");
 m_int_addr=32'h7f20;int_mask=1;m_inst_addr=${mode === 'wrong-ack' ? "32'h4190" : "32'h41c0"};macroscopic_pc=32'h41c0;
 tick; int_mask=0;
 macroscopic_pc=${mode === 'unaligned' ? "32'h41c5" : "32'h41c4"};
 repeat(${mode === 'stalled' ? 9 : 2}) begin tick; if(interrupt)$fatal(1,"IRQ while eret remains current"); end
 ${mode === 'unknown' ? "macroscopic_pc=32'hxxxxxxxx; repeat(3)begin tick;if(interrupt)$fatal(1,\"unknown PC advanced boundary\");end" : ''}
 macroscopic_pc=32'h3040;
 tick;
 if(${mode === 'unaligned' ? 'interrupt' : '!interrupt'})$fatal(1,"wrong return observation result");
 if(interrupt)begin m_int_addr=32'h7f20;int_mask=1;tick;int_mask=0;end
 repeat(4)tick;
 $display("PROTOCOL_DONE");$finish;
end
endmodule\n`;
    fs.writeFileSync(path.join(dir, `${mode}.v`), source);
    const output = path.join(dir, `${mode}.vvp`);
    const environment = buildIverilogEnvironment(runtime);
    const compile = spawnSync(runtime.iverilogPath, [...buildIverilogRuntimeArgs(runtime), '-g2005', '-s', 'tb', '-o', output, path.join(dir, `${mode}.v`)],
      { env: environment, encoding: 'utf8', timeout: 10000 });
    expect(compile.status, compile.stderr).toBe(0);
    const result = spawnSync(runtime.vvpPath, ['-N', output], { env: environment, encoding: 'utf8', timeout: 10000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('PROTOCOL_DONE');
    return result.stdout;
  }

  it.each(['short', 'stalled', 'unknown', 'low-address-bits', 'forwarded-unselected', 'request-gated-ack'] as const)('%s uses actual PC departure and acknowledges two requests', mode => {
    const output = run(mode);
    expect(output.match(/external_raise scenario=2/g)).toHaveLength(1);
    expect(output.match(/external_ack scenario=2/g)).toHaveLength(1);
    expect(output.indexOf('external_ack scenario=1')).toBeLessThan(output.indexOf('return_seen scenario=2'));
    expect(output.indexOf('return_seen scenario=2')).toBeLessThan(output.indexOf('return_exit scenario=2'));
    expect(output).not.toContain('uut.');
    expect(output).not.toContain('invalid_store_effect');
    expect(output.match(/return_ack_store/g)).toHaveLength(2);
  });

  it('does not mask an unaligned PC into an eret observation', () => {
    const output = run('unaligned');
    expect(output).not.toContain('return_seen scenario=2');
    expect(output).not.toContain('external_raise scenario=2');
  });

  it('reports an interrupt-generator write from a different instruction', () => {
    expect(run('wrong-ack')).toContain('invalid_store_effect source=interrupt_generator');
  });
});
