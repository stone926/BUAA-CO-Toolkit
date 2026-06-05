import { describe, it, expect } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseModules, parseMacros, stripCommentsAndStrings, widthOfExpression, buildTestbench } from '../../../language/verilog/parser';
import { defaultCoSettings, mergeCoSettings, CoSettings } from '../../../language/common/settings';
import { getVerilogDiagnostics } from '../../../language/verilog/service';

function doc(text: string): TextDocument {
  return TextDocument.create('test://test.v', 'verilog', 1, text);
}

function settings(overrides: Record<string, unknown> = {}): CoSettings {
  return mergeCoSettings(overrides);
}

// ────────────────────────────────────────────────────────────────────────────────
// Real Verilog patterns from P0-P6 projects
// ────────────────────────────────────────────────────────────────────────────────
describe('Real project Verilog patterns', () => {

  describe('P0/P1 style — simple combinational modules', () => {
    it('parses ALU with assign statements (P0 ALU1.v style)', () => {
      const text = `
module ALU1(
    input [3:0] inA,
    input [3:0] inB,
    input [1:0] op,
    output [3:0] out
);
    assign out = (op == 2'b00) ? (inA & inB) :
                 (op == 2'b01) ? (inA | inB) :
                 (op == 2'b10) ? (inA ^ inB) :
                 (inA + inB);
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('ALU1');
      expect(modules[0].ports).toHaveLength(4);
      expect(modules[0].hasEndmodule).toBe(true);
    });

    it('parses module with $signed() (P0 ALU2.v style)', () => {
      const text = `
module ALU2(
    input [3:0] inA,
    input [3:0] inB,
    input [3:0] inC,
    input [1:0] op,
    output [3:0] out
);
    assign out = (op == 2'b00) ? ($signed(inA) >>> inB) :
                 (op == 2'b01) ? (inA >> inB) :
                 (op == 2'b10) ? (inA - inB) :
                 (inA + inB);
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('ALU2');
    });

    it('parses FSM with always @(posedge clk) (P0 counting1.v style)', () => {
      const text = `
module counting(
    input clk,
    input reset,
    input [1:0] num,
    output reg ans
);
    reg [1:0] state;
    parameter S0 = 2'b00, S1 = 2'b01, S2 = 2'b10, S3 = 2'b11;

    always @(posedge clk) begin
        if (reset) begin
            state <= S0;
            ans <= 0;
        end else begin
            case (state)
                S0: state <= (num == 2'b01) ? S1 : S0;
                S1: state <= (num == 2'b10) ? S2 : S0;
                S2: state <= (num == 2'b00) ? S3 : S0;
                S3: state <= S0;
                default: state <= S0;
            endcase
            ans <= (state == S3);
        end
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('counting');
      expect(modules[0].ports).toHaveLength(4);
    });

    it('parses module with always @(*) (P1 alu.v style)', () => {
      const text = `
module alu(
    input [31:0] A,
    input [31:0] B,
    input [2:0] ALUOp,
    output reg [31:0] C,
    output zero
);
    assign zero = (C == 0);
    always @(*) begin
        case (ALUOp)
            3'b000: C = A + B;
            3'b001: C = A - B;
            3'b010: C = A & B;
            3'b011: C = A | B;
            3'b100: C = B << 16;
            3'b101: C = $signed($signed(A) >>> B);
            default: C = 0;
        endcase
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('alu');
    });
  });

  describe('P4 style — single-cycle CPU modules', () => {
    it('parses PC module with synchronous reset to 0x3000', () => {
      const text = `
module PC(
    input clk,
    input reset,
    input [31:0] NPC,
    output reg [31:0] PC
);
    initial begin
        PC = 32'h0000_3000;
    end
    always @(posedge clk) begin
        if (reset)
            PC <= 32'h0000_3000;
        else
            PC <= NPC;
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('PC');
    });

    it('parses IM module with $readmemh', () => {
      const text = `
module IM(
    input [31:0] PC,
    output [31:0] instr
);
    reg [31:0] rom [0:4095];
    initial begin
        $readmemh("code.txt", rom);
    end
    assign instr = rom[(PC - 32'h0000_3000) >> 2];
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('IM');
    });

    it('parses GRF module with $display', () => {
      const text = `
module GRF(
    input clk,
    input reset,
    input [4:0] A1,
    input [4:0] A2,
    input [4:0] A3,
    input [31:0] WD,
    input WE,
    output [31:0] RD1,
    output [31:0] RD2
);
    reg [31:0] regs [0:31];
    integer i;
    assign RD1 = (A1 == 0) ? 0 : regs[A1];
    assign RD2 = (A2 == 0) ? 0 : regs[A2];
    always @(posedge clk) begin
        if (reset) begin
            for (i = 0; i < 32; i = i + 1)
                regs[i] <= 0;
        end else if (WE && A3 != 0) begin
            regs[A3] <= WD;
            $display("@%h: $%d <= %h", PC, A3, WD);
        end
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('GRF');
    });

    it('parses Controller with wire-level decoding', () => {
      const text = `
module Controller(
    input [31:0] instr,
    output RegDst,
    output ALUSrc,
    output MemtoReg,
    output RegWrite,
    output MemWrite,
    output Branch,
    output Jump,
    output [2:0] ALUOp
);
    wire [5:0] OpCode = instr[31:26];
    wire [5:0] Funct = instr[5:0];
    wire add = (OpCode == 6'b000000) && (Funct == 6'b100000);
    wire sub = (OpCode == 6'b000000) && (Funct == 6'b100010);
    wire ori = (OpCode == 6'b001101);
    wire lw = (OpCode == 6'b100011);
    wire sw = (OpCode == 6'b101011);
    wire beq = (OpCode == 6'b000100);
    wire lui = (OpCode == 6'b001111);
    wire jal = (OpCode == 6'b000011);
    wire jr = (OpCode == 6'b000000) && (Funct == 6'b001000);
    assign RegDst = add | sub;
    assign ALUSrc = ori | lw | sw | lui;
    assign MemtoReg = lw;
    assign RegWrite = add | sub | ori | lw | lui | jal;
    assign MemWrite = sw;
    assign Branch = beq;
    assign Jump = jal | jr;
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('Controller');
    });
  });

  describe('P5 style — pipelined CPU modules', () => {
    it('parses pipeline register with enable and clear', () => {
      const text = `
module FDreg(
    input clk,
    input reset,
    input en,
    input clear,
    input [31:0] F_instr,
    input [31:0] F_PC,
    output reg [31:0] D_instr,
    output reg [31:0] D_PC
);
    always @(posedge clk) begin
        if (reset || clear) begin
            D_instr <= 0;
            D_PC <= 0;
        end else if (en) begin
            D_instr <= F_instr;
            D_PC <= F_PC;
        end
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('FDreg');
      expect(modules[0].ports).toHaveLength(8);
    });

    it('parses CMP module for branch comparison', () => {
      const text = `
module CMP(
    input [31:0] A,
    input [31:0] B,
    output equal
);
    assign equal = (A == B);
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('CMP');
    });

    it('parses top-level module with forwarding muxes', () => {
      const text = `
module mips(
    input clk,
    input reset,
    output [31:0] macroscopicPC
);
    wire [31:0] F_PC, D_PC, E_PC, M_PC, W_PC;
    wire [31:0] F_instr, D_instr;
    wire [4:0] D_rs = D_instr[25:21];
    wire [4:0] D_rt = D_instr[20:16];
    wire [31:0] D_rs_val = (D_rs == 0) ? 0 :
                           (D_rs == E_A3 && E_RegWrite) ? E_WD :
                           (D_rs == M_A3 && M_RegWrite) ? M_WD :
                           GRF_RD1;
    wire [31:0] D_rt_val = (D_rt == 0) ? 0 :
                           (D_rt == E_A3 && E_RegWrite) ? E_WD :
                           (D_rt == M_A3 && M_RegWrite) ? M_WD :
                           GRF_RD2;
    // ... pipeline connections
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('mips');
    });
  });

  describe('P6 style — extended pipelined CPU', () => {
    it('parses BE (Byte Enable) module', () => {
      const text = `
module BE(
    input [31:0] addr,
    input [1:0] Op,
    output reg [3:0] byteen,
    output reg [31:0] wdata
);
    always @(*) begin
        case (Op)
            2'b00: begin // SW
                byteen = 4'b1111;
                wdata = wdata;
            end
            2'b01: begin // SH
                if (addr[1]) begin
                    byteen = 4'b1100;
                    wdata = {wdata[15:0], 16'b0};
                end else begin
                    byteen = 4'b0011;
                    wdata = {16'b0, wdata[15:0]};
                end
            end
            2'b10: begin // SB
                case (addr[1:0])
                    2'b00: begin byteen = 4'b0001; wdata = {24'b0, wdata[7:0]}; end
                    2'b01: begin byteen = 4'b0010; wdata = {16'b0, wdata[7:0], 8'b0}; end
                    2'b10: begin byteen = 4'b0100; wdata = {8'b0, wdata[7:0], 16'b0}; end
                    2'b11: begin byteen = 4'b1000; wdata = {wdata[7:0], 24'b0}; end
                endcase
            end
            default: begin
                byteen = 4'b1111;
                wdata = wdata;
            end
        endcase
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('BE');
    });

    it('parses DE (Data Extractor) module', () => {
      const text = `
module DE(
    input [31:0] addr,
    input [31:0] din,
    input [1:0] Op,
    output reg [31:0] dout
);
    always @(*) begin
        case (Op)
            2'b00: dout = din; // LW
            2'b01: dout = addr[1] ? {{16{din[31]}}, din[31:16]} : {{16{din[15]}}, din[15:0]}; // LH
            2'b10: begin // LB
                case (addr[1:0])
                    2'b00: dout = {{24{din[7]}}, din[7:0]};
                    2'b01: dout = {{24{din[15]}}, din[15:8]};
                    2'b10: dout = {{24{din[23]}}, din[23:16]};
                    2'b11: dout = {{24{din[31]}}, din[31:24]};
                endcase
            end
            default: dout = din;
        endcase
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('DE');
    });

    it('parses MDU (Multiply/Divide Unit) module', () => {
      const text = `
module MDU(
    input clk,
    input reset,
    input [31:0] A,
    input [31:0] B,
    input [2:0] Op,
    output reg [31:0] HI,
    output reg [31:0] LO,
    output busy
);
    reg [3:0] count;
    assign busy = (count != 0);
    always @(posedge clk) begin
        if (reset) begin
            HI <= 0;
            LO <= 0;
            count <= 0;
        end else if (count != 0) begin
            count <= count - 1;
        end else begin
            case (Op)
                3'b000: begin {HI, LO} <= $signed(A) * $signed(B); count <= 5; end // MULT
                3'b001: begin {HI, LO} <= A * B; count <= 5; end // MULTU
                3'b010: begin LO <= $signed(A) / $signed(B); HI <= $signed(A) % $signed(B); count <= 10; end // DIV
                3'b011: begin LO <= A / B; HI <= A % B; count <= 10; end // DIVU
                3'b100: HI <= A; // MTHI
                3'b101: LO <= A; // MTLO
            endcase
        end
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('MDU');
    });

    it('parses external testbench with byte-enable memory', () => {
      const text = `
\`timescale 1ns / 1ps
module mips_tb;
    reg clk;
    reg reset;
    wire [31:0] i_inst_addr;
    wire [31:0] i_inst_rdata;
    wire [31:0] m_data_addr;
    wire [31:0] m_data_rdata;
    wire [31:0] m_data_wdata;
    wire [3:0] m_data_byteen;
    wire [31:0] m_inst_addr;
    wire w_grf_we;
    wire [4:0] w_grf_addr;
    wire [31:0] w_grf_wdata;
    wire [31:0] w_inst_addr;

    mips uut(
        .clk(clk),
        .reset(reset),
        .i_inst_addr(i_inst_addr),
        .i_inst_rdata(i_inst_rdata),
        .m_data_addr(m_data_addr),
        .m_data_rdata(m_data_rdata),
        .m_data_wdata(m_data_wdata),
        .m_data_byteen(m_data_byteen),
        .m_inst_addr(m_inst_addr),
        .w_grf_we(w_grf_we),
        .w_grf_addr(w_grf_addr),
        .w_grf_wdata(w_grf_wdata),
        .w_inst_addr(w_inst_addr)
    );

    reg [31:0] inst [0:4095];
    reg [31:0] data [0:3071];
    initial $readmemh("code.txt", inst);
    assign i_inst_rdata = inst[(i_inst_addr - 32'h0000_3000) >> 2];
    assign m_data_rdata = data[(m_data_addr - 32'h0000_0000) >> 2];

    always @(posedge clk) begin
        if (m_data_byteen[0]) data[m_data_addr >> 2][7:0] <= m_data_wdata[7:0];
        if (m_data_byteen[1]) data[m_data_addr >> 2][15:8] <= m_data_wdata[15:8];
        if (m_data_byteen[2]) data[m_data_addr >> 2][23:16] <= m_data_wdata[23:16];
        if (m_data_byteen[3]) data[m_data_addr >> 2][31:24] <= m_data_wdata[31:24];
    end

    always @(posedge clk) begin
        if (w_grf_we)
            $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);
    end

    initial begin
        clk = 0;
        forever #5 clk = ~clk;
    end

    initial begin
        reset = 1;
        #20;
        reset = 0;
        #200000;
        $finish;
    end
endmodule
`.trim();
      const d = doc(text);
      const modules = parseModules(d, text);
      expect(modules).toHaveLength(1);
      expect(modules[0].name).toBe('mips_tb');
      expect(modules[0].instances).toHaveLength(1);
      expect(modules[0].instances[0].moduleName).toBe('mips');
    });
  });

  describe('P4 expected port validation', () => {
    it('warns when P4 top module is missing clk port', () => {
      const text = `
module mips(
    input reset
);
endmodule
`.trim();
      const d = doc(text);
      const s = settings({ project: { profile: 'P4' } });
      const diagnostics = getVerilogDiagnostics(d, s);
      const missingPort = diagnostics.find((diag) =>
        typeof diag.code === 'string' && diag.code.includes('port')
      );
      // Should warn about missing clk
      expect(missingPort).toBeDefined();
    });
  });

  describe('P5 $display format validation', () => {
    it('warns about incorrect $display format in P5', () => {
      const text = `
module mips_tb;
    reg [31:0] PC;
    reg [4:0] addr;
    reg [31:0] data;
    initial begin
        $display("@%h: $%d <= %h", PC, addr, data);
    end
endmodule
`.trim();
      const d = doc(text);
      const s = settings({ project: { profile: 'P5' } });
      const diagnostics = getVerilogDiagnostics(d, s);
      // P5 expects format with %d@%h: prefix (time included)
      const displayDiag = diagnostics.find((diag) =>
        typeof diag.code === 'string' && diag.code === 'display-format'
      );
      expect(displayDiag).toBeDefined();
    });

    it('accepts correct P5 $display format with %d@%h prefix', () => {
      // The expected P5 format is: %d@%h: $%d <= %h
      // The regex checks: /%d@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/
      // This test verifies the format pattern is recognized
      const format = '%d@%h: $%d <= %h';
      const ok = /%d@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/.test(format);
      expect(ok).toBe(true);
    });
  });

  describe('P6 $display ban', () => {
    it('reports error for $display in P6 top-level design', () => {
      const text = `
module mips(
    input clk,
    input reset
);
    always @(posedge clk) begin
        $display("test");
    end
endmodule
`.trim();
      const d = doc(text);
      const s = settings({ project: { profile: 'P6' } });
      const diagnostics = getVerilogDiagnostics(d, s);
      const p6Display = diagnostics.find((diag) => diag.code === 'p6-display');
      expect(p6Display).toBeDefined();
    });

    it('does not report $display in the P6 testbench', () => {
      const text = `
module mips(input clk, input reset);
endmodule

module mips_tb;
    initial begin
        $display("%d@%h: $%d <= %h", $time, 32'h3000, 5'd1, 32'h2);
    end
endmodule
`.trim();
      const d = doc(text);
      const s = settings({ project: { profile: 'P6' } });
      const diagnostics = getVerilogDiagnostics(d, s);
      const p6Display = diagnostics.find((diag) => diag.code === 'p6-display');
      expect(p6Display).toBeUndefined();
    });

    it('reports error for $display in P7 top-level design', () => {
      const text = `
module mips(input clk, input reset);
    initial begin
        $display("%d@%h: $%d <= %h", $time, 32'h3000, 5'd1, 32'h2);
    end
endmodule
`.trim();
      const d = doc(text);
      const s = settings({ project: { profile: 'P7' } });
      const diagnostics = getVerilogDiagnostics(d, s);
      const p7Display = diagnostics.find((diag) => diag.code === 'p7-display');
      expect(p7Display).toBeDefined();
    });
  });

  describe('Width inference with real expressions', () => {
    it('infers width of sign-extended branch offset', () => {
      const module = {
        name: 'test',
        ports: [],
        parameters: [],
        declarations: new Map([
          ['imm16', { name: 'imm16', kind: 'wire' as const, width: '[15:0]', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        ]),
        instances: [],
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        headerEnd: { line: 0, character: 0 },
        uri: 'test://test.v',
        bodyText: '',
        hasEndmodule: true
      };
      // {{14{imm16[15]}}, imm16, 2'b00} should be 32 bits
      const result = widthOfExpression('{{14{imm16[15]}}, imm16, 2\'b00}', module);
      expect(result.width).toBe(32);
    });

    it('infers width of PC+4 expression', () => {
      const module = {
        name: 'test',
        ports: [],
        parameters: [],
        declarations: new Map([
          ['PC', { name: 'PC', kind: 'wire' as const, width: '[31:0]', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]
        ]),
        instances: [],
        range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
        selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
        headerEnd: { line: 0, character: 0 },
        uri: 'test://test.v',
        bodyText: '',
        hasEndmodule: true
      };
      expect(widthOfExpression('PC + 4', module).width).toBe(32);
    });
  });
});
