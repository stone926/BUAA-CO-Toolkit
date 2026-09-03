import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { buildTestbench, parseModules } from '../../language/verilog/parser';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { renderResourceTemplate } from '../../templates/templateRegistry';
import { createVerilogSimulationFailure, verilogSimulationFailureMessage } from '../../verilog/simulationDiagnostic';

const extensionRoot = path.resolve(__dirname, '../../..');
const executableSuffix = process.platform === 'win32' ? '.exe' : '';
const runtimeRoot = path.join(extensionRoot, 'vendor', 'iverilog', `${process.platform}-${process.arch}`);
const compiler = path.join(runtimeRoot, 'bin', `iverilog${executableSuffix}`);
const simulator = path.join(runtimeRoot, 'bin', `vvp${executableSuffix}`);
const runtimeAvailable = fs.existsSync(compiler) && fs.existsSync(simulator);

interface StoreVector {
  name: string;
  opcode: number;
  address: string;
  addressLiteral?: string;
  wordAddress?: string;
  byteen: string;
  data: string;
  pc?: string;
  failure?: string;
}

const vectors: StoreVector[] = [
  ...Array.from({ length: 4 }, (_, lane): StoreVector => ({
    name: `sb lane ${lane} with disabled lanes unknown`, opcode: 0x28,
    address: hex(lane), byteen: (1 << lane).toString(2).padStart(4, '0'),
    data: 'xxxxxxxx'.slice(0, 6 - lane * 2) + 'ab' + 'xxxxxxxx'.slice(0, lane * 2)
  })),
  { name: 'sh low half', opcode: 0x29, address: '00000000', byteen: '0011', data: 'xxxxbeef' },
  { name: 'sh high half', opcode: 0x29, address: '00000002', byteen: '1100', data: 'beefxxxx' },
  { name: 'sw', opcode: 0x2b, address: '00000000', byteen: '1111', data: '12345678' },
  ...Array.from({ length: 4 }, (_, lane): StoreVector => ({
    name: `swl offset ${lane}`, opcode: 0x2a, address: hex(lane),
    byteen: (0xf >> (3 - lane)).toString(2).padStart(4, '0'),
    data: 'xxxxxxxx'.slice(0, (3 - lane) * 2) + '12345678'.slice(0, (lane + 1) * 2)
  })),
  ...Array.from({ length: 4 }, (_, lane): StoreVector => ({
    name: `swr offset ${lane}`, opcode: 0x2e, address: hex(lane),
    byteen: ((0xf << lane) & 0xf).toString(2).padStart(4, '0'),
    data: '12345678'.slice(lane * 2) + 'xxxxxxxx'.slice(0, lane * 2)
  })),
  { name: 'sb read-modify-write with 1111 mask', opcode: 0x28, address: '00000001', byteen: '1111', data: '0000ab00', pc: '00003004', failure: 'byte_enable' },
  { name: 'sh read-modify-write with 1111 mask', opcode: 0x29, address: '00000002', byteen: '1111', data: 'beef0000', pc: '00003014', failure: 'byte_enable' },
  { name: 'unknown mask on an active write', opcode: 0x28, address: '00000000', byteen: '00x1', data: 'xxxxxxab', failure: 'byte_enable' },
  { name: 'unknown enabled data', opcode: 0x28, address: '00000000', byteen: '0001', data: 'xxxxxxax', failure: 'unknown_enabled_lane' },
  { name: 'unknown effective address', opcode: 0x28, address: 'xxxxxxx0', byteen: '0001', data: 'xxxxxxab', failure: 'invalid_address' },
  { name: 'out-of-range DM write', opcode: 0x2b, address: '00003000', byteen: '1111', data: '12345678', failure: 'invalid_address' },
  { name: 'MMIO incorrectly routed onto DM write port', opcode: 0x2b, address: '00007f00', byteen: '1111', data: '12345678', failure: 'invalid_address' },
  { name: 'unknown store PC', opcode: 0x28, address: '00000000', byteen: '0001', data: 'xxxxxxab', pc: 'xxxxxxxx', failure: 'invalid_pc' },
  { name: 'unaligned store PC', opcode: 0x28, address: '00000000', byteen: '0001', data: 'xxxxxxab', pc: '00003001', failure: 'invalid_pc' },
  { name: 'store PC below IM', opcode: 0x28, address: '00000000', byteen: '0001', data: 'xxxxxxab', pc: '00002ffc', failure: 'invalid_pc' },
  { name: 'store PC beyond IM', opcode: 0x28, address: '00000000', byteen: '0001', data: 'xxxxxxab', pc: '00007000', failure: 'invalid_pc' },
  { name: 'write from a non-store instruction', opcode: 0x23, address: '00000000', byteen: '0001', data: 'xxxxxxab', failure: 'non_store_instruction' },
  { name: 'idle bubble with unknown PC and data', opcode: 0x28, address: 'xxxxxxxx', byteen: '0000', data: 'xxxxxxxx', pc: 'xxxxxxxx' },
  { name: 'retained load PC is not a load-valid signal', opcode: 0x23, address: 'xxxxxxxx', byteen: '0000', data: 'xxxxxxxx' },
  { name: 'legal device access has no DM write', opcode: 0x2b, address: '00007f00', byteen: '0000', data: 'xxxxxxxx' },
  { name: 'sw ignores both unknown low address bits', opcode: 0x2b, address: '0000000x', addressLiteral: "{30'b0, 2'bxx}", wordAddress: '00000000', byteen: '1111', data: '12345678' },
  { name: 'sw ignores both high-impedance low address bits', opcode: 0x2b, address: '0000000z', addressLiteral: "{30'b0, 2'bzz}", wordAddress: '00000000', byteen: '1111', data: '12345678' },
  { name: 'sw ignores known nonzero low address bits', opcode: 0x2b, address: '00000003', byteen: '1111', data: '12345678' },
  { name: 'sw last word preserves address when raw low nibble contains X', opcode: 0x2b, address: '00002ffx', addressLiteral: "{30'h00000bff, 2'bxx}", wordAddress: '00002ffc', byteen: '1111', data: '12345678' },
  { name: 'sh low half ignores unknown bit 0', opcode: 0x29, address: '0000000x', addressLiteral: "{30'b0, 2'b0x}", wordAddress: '00000000', byteen: '0011', data: 'xxxxbeef' },
  { name: 'sh high half ignores unknown bit 0', opcode: 0x29, address: '0000000x', addressLiteral: "{30'b0, 2'b1x}", wordAddress: '00000000', byteen: '1100', data: 'beefxxxx' },
  { name: 'sh high half ignores high-impedance bit 0', opcode: 0x29, address: '0000000z', addressLiteral: "{30'b0, 2'b1z}", wordAddress: '00000000', byteen: '1100', data: 'beefxxxx' },
  { name: 'sh ignores known nonzero bit 0', opcode: 0x29, address: '00000003', byteen: '1100', data: 'beefxxxx' },
  { name: 'sb rejects unknown lane-selecting address bit', opcode: 0x28, address: '0000000x', addressLiteral: "{30'b0, 2'b0x}", wordAddress: '00000000', byteen: '0001', data: 'xxxxxxab', failure: 'invalid_address' },
  { name: 'sh rejects unknown half-selecting address bit', opcode: 0x29, address: '0000000x', addressLiteral: "{30'b0, 2'bx0}", wordAddress: '00000000', byteen: '0011', data: 'xxxxbeef', failure: 'invalid_address' },
  { name: 'swl rejects unknown lane-selecting address bit', opcode: 0x2a, address: '0000000x', addressLiteral: "{30'b0, 2'b0x}", wordAddress: '00000000', byteen: '0001', data: 'xxxxxxab', failure: 'invalid_address' },
  { name: 'swr rejects high-impedance lane-selecting address bit', opcode: 0x2e, address: '0000000z', addressLiteral: "{30'b0, 2'b0z}", wordAddress: '00000000', byteen: '1111', data: '12345678', failure: 'invalid_address' }
];

describe.skipIf(!runtimeAvailable)('public DM store contract with bundled Icarus', () => {
  let workDir: string;

  beforeAll(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'co-dm-store-contract-'));
    const image = Array.from({ length: 4096 }, (_, index) => hex((vectors[index]?.opcode ?? 0) << 26));
    fs.writeFileSync(path.join(workDir, 'code.txt'), image.join('\n'));
    for (const profile of ['P6', 'P7'] as const) {
      const source = scriptedDut(profile);
      fs.writeFileSync(path.join(workDir, `${profile}.v`), source);
      const document = TextDocument.create(`${profile}.v`, 'verilog', 1, source);
      const checked = buildTestbench(parseModules(document, source)[0], 'contract_tb', { profile });
      expect(checked).not.toContain('uut.');
      const contract = renderResourceTemplate('verilog/dm_store_contract.v', {
        activeCondition: '!reset && ', userTextBase: "32'h3000", instructionMemoryWords: 4096, dataMemoryBytes: 12288
      });
      expect(checked).toContain(contract);
      for (const [suffix, testbench] of [['checked', checked], ['original', checked.replace(contract, '')]]) {
        const file = `${profile}-${suffix}`;
        fs.writeFileSync(path.join(workDir, `${file}.v`), testbench);
        const result = spawnSync(compiler, [
          '-B', path.join(runtimeRoot, 'lib', 'ivl'), '-g2005', '-s', 'contract_tb',
          '-o', `${file}.vvp`, `${profile}.v`, `${file}.v`
        ], { cwd: workDir, encoding: 'utf8', timeout: 10000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      }
    }
  });

  afterAll(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  for (const profile of ['P6', 'P7'] as const) {
    for (const [index, vector] of vectors.entries()) {
      it(`${profile}: ${vector.name}`, () => {
        const result = runVector(workDir, profile, 'checked', index);
        if (vector.failure) {
          expect(result.status).not.toBe(0);
          expect(result.stdout).toContain(`CO_DM_CONTRACT ${vector.failure}`);
          const failure = createVerilogSimulationFailure('iverilog', 'simulate', {
            ok: false, exitCode: result.status, commandLine: simulator, cwd: workDir,
            stdout: result.stdout, stderr: result.stderr, timedOut: false, stopped: false
          }, workDir);
          expect(verilogSimulationFailureMessage(failure, 'iverilog')).toContain(`CO_DM_CONTRACT ${vector.failure}`);
          expect(failure.diagnostic?.message.toLowerCase()).toContain(`addr=${vector.address}`);
        } else {
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(result.stdout).not.toContain('CO_DM_CONTRACT');
        }
        if (vector.byteen === '0000') {
          expect(result.stdout).not.toContain('CO_DM_STORE');
          expect(parseSimOutput(result.stdout)).toEqual([]);
        } else {
          expect(result.stdout.toLowerCase()).toContain(`addr=${vector.address} word=`);
          expect(result.stdout).toContain(`byteen=${vector.byteen} wdata=${vector.data}`);
          if (vector.wordAddress) expect(result.stdout).toContain(`word=${vector.wordAddress}`);
          if (!vector.failure) {
            const events = parseSimOutput(result.stdout);
            expect(events).toHaveLength(1);
            expect(events[0].kind).toBe('dm');
          }
        }
      });
    }

    it(`${profile}: detects the identical merged-word SB/SH counterexamples`, () => {
      for (const [correct, broken] of [[1, 15], [5, 16]]) {
        const oldCorrect = parseSimOutput(runVector(workDir, profile, 'original', correct).stdout);
        const oldBroken = parseSimOutput(runVector(workDir, profile, 'original', broken).stdout);
        expect(oldCorrect).toHaveLength(1);
        expect(oldBroken).toHaveLength(1);
        expect(oldCorrect).toEqual(oldBroken);
        expect(runVector(workDir, profile, 'checked', correct).status).toBe(0);
        expect(runVector(workDir, profile, 'checked', broken).status).not.toBe(0);
      }
    });
  }
});

function runVector(workDir: string, profile: string, mode: string, index: number) {
  const result = spawnSync(simulator, ['-N', `${profile}-${mode}.vvp`, `+vector=${index}`], {
    cwd: workDir, encoding: 'utf8', timeout: 5000
  });
  expect(result.error).toBeUndefined();
  return result;
}

function hex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

function scriptedDut(profile: 'P6' | 'P7'): string {
  return `\`timescale 1ns/1ps
module mips(
    input clk, input reset,
    input [31:0] i_inst_rdata, input [31:0] m_data_rdata,
    output [31:0] i_inst_addr,
    output reg [31:0] m_data_addr, output reg [31:0] m_data_wdata,
    output reg [3:0] m_data_byteen, output reg [31:0] m_inst_addr,
    output w_grf_we, output [4:0] w_grf_addr, output [31:0] w_grf_wdata,
    output [31:0] w_inst_addr${profile === 'P7' ? `,
    input interrupt, output [31:0] macroscopic_pc,
    output [31:0] m_int_addr, output [3:0] m_int_byteen` : ''}
);
    assign i_inst_addr = 32'h3000;
    assign w_grf_we = 1'b1;
    assign w_grf_addr = 5'b0;
    assign w_grf_wdata = 32'bx;
    assign w_inst_addr = 32'bx;
    ${profile === 'P7' ? "assign macroscopic_pc = 32'h3000; assign m_int_addr = 32'h7f20; assign m_int_byteen = 4'b0001;" : ''}
    integer vector;
    initial begin
        m_data_byteen = 0; m_data_addr = 32'bx; m_data_wdata = 32'bx; m_inst_addr = 32'bx;
        if (!$value$plusargs("vector=%d", vector)) $fatal(1, "missing vector");
        @(negedge reset);
        @(negedge clk);
        case (vector)
${vectors.map((vector, index) => `            ${index}: begin
                m_inst_addr = 32'h${vector.pc ?? hex(0x3000 + index * 4)};
                m_data_addr = ${vector.addressLiteral ?? `32'h${vector.address}`};
                m_data_wdata = 32'h${vector.data};
                m_data_byteen = 4'b${vector.byteen};
            end`).join('\n')}
        endcase
        @(negedge clk);
        m_data_byteen = 0;
        #1 $finish;
    end
endmodule
`;
}
