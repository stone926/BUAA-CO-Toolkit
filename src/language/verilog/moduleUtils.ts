import { Position } from 'vscode-languageserver/node';
import { containsPosition } from '../common/lsp';
import { ProjectProfile } from '../../projectProfile';
import { VerilogDecl, VerilogModule } from './model';

export function moduleAtPosition(modules: VerilogModule[], position: Position): VerilogModule | undefined {
  return modules.find((module) => containsPosition(module.range, position));
}

export function declDetail(decl: VerilogDecl): string {
  return `${decl.direction ?? decl.kind} ${decl.width ? `${decl.width} ` : ''}${decl.name}`.trim();
}

interface TestbenchOptions {
  finishDelay?: string;
  profile?: ProjectProfile;
  interruptSchedule?: number[];
}

export function buildTestbench(module: VerilogModule, tbName: string, options: TestbenchOptions = {}): string {
  const finishDelay = options.finishDelay?.trim() || '200000';
  const hasExternalInstructionMemory = hasPort(module, 'i_inst_addr') && hasPort(module, 'i_inst_rdata');
  const hasExternalDataMemory = hasPort(module, 'm_data_addr') && hasPort(module, 'm_data_rdata') && hasPort(module, 'm_data_wdata') && hasPort(module, 'm_data_byteen');
  const hasCourseExternalMemory = hasExternalInstructionMemory || hasExternalDataMemory;
  const isP7ExternalInterface = hasPort(module, 'interrupt') || hasPort(module, 'macroscopic_pc') || hasPort(module, 'm_int_addr') || hasPort(module, 'm_int_byteen');
  if (options.profile === 'P7' || isP7ExternalInterface) {
    return buildP7OfficialTestbench(module.name, tbName, options.interruptSchedule);
  }
  const hasWritebackTrace = hasPort(module, 'w_grf_we') && hasPort(module, 'w_grf_addr') && hasPort(module, 'w_grf_wdata') && hasPort(module, 'w_inst_addr');
  const hasDataMemoryTrace = hasExternalDataMemory && hasPort(module, 'm_inst_addr');
  const declarations = module.ports.map((port) => {
    const kind = testbenchSignalKind(port, hasCourseExternalMemory);
    return `    ${kind} ${port.width ? `${port.width} ` : ''}${port.name};`;
  });
  const connections = module.ports.map((port, index) => {
    const comma = index === module.ports.length - 1 ? '' : ',';
    return `        .${port.name}(${port.name})${comma}`;
  });
  const hasClk = module.ports.some((port) => port.name === 'clk');
  const hasReset = module.ports.some((port) => port.name === 'reset');
  const lines: string[] = [
    '`timescale 1ns / 1ps',
    '',
    `module ${tbName};`,
    ...declarations
  ];

  if (hasExternalInstructionMemory) {
    lines.push(`    reg [31:0] inst[0:${isP7ExternalInterface ? 5119 : 4095}];`);
  }
  if (hasExternalDataMemory) {
    lines.push('    reg [31:0] data[0:4095];', '    integer i;', '    reg [31:0] fixed_addr;', '    reg [31:0] fixed_wdata;');
  }

  lines.push(
    '',
    `    ${module.name} uut (`,
    ...connections,
    '    );',
    ''
  );

  if (hasExternalInstructionMemory || hasExternalDataMemory) {
    lines.push(...externalMemoryInitialLines(hasExternalInstructionMemory, hasExternalDataMemory, isP7ExternalInterface), '');
  }

  if (hasExternalInstructionMemory) {
    lines.push(isP7ExternalInterface
      ? '    assign i_inst_rdata = inst[((i_inst_addr - 32\'h3000) >> 2) % 5120];'
      : '    assign i_inst_rdata = inst[(i_inst_addr - 32\'h3000) >> 2];');
  }
  if (hasExternalDataMemory) {
    lines.push(isP7ExternalInterface
      ? '    assign m_data_rdata = data[(m_data_addr >> 2) % 5120];'
      : '    assign m_data_rdata = data[m_data_addr >> 2];');
  }
  if (hasExternalInstructionMemory || hasExternalDataMemory) {
    lines.push('');
  }

  if (hasExternalDataMemory && hasClk) {
    lines.push(...externalDataMemoryWriteLines(hasReset, isP7ExternalInterface, hasDataMemoryTrace), '');
  }

  if (hasWritebackTrace && hasClk) {
    lines.push(...writebackTraceLines(hasReset), '');
  }

  if (hasCourseExternalMemory) {
    lines.push(...courseExternalInitialLines(module, hasClk, hasReset), '');
    if (hasClk) {
      lines.push('    always #2 clk <= ~clk;', '');
    }
    lines.push('endmodule', '');
    return lines.join('\n');
  }

  if (hasClk) {
    lines.push(
      '    initial begin',
      "        clk = 1'b0;",
      '        forever #5 clk = ~clk;',
      '    end',
      ''
    );
  }

  lines.push('    initial begin');
  if (hasReset) {
    lines.push(
      "        reset = 1'b1;",
      '        #20;',
      "        reset = 1'b0;"
    );
  }
  lines.push(`        #${finishDelay};`, '        $finish;', '    end', 'endmodule', '');
  return lines.join('\n');
}

function buildP7OfficialTestbench(topModuleName: string, tbName: string, interruptSchedule?: number[]): string {
  return [
    '`timescale 1ns/1ps',
    '',
    `module ${tbName};`,
    '',
    '    reg clk;',
    '    reg reset;',
    '    reg interrupt;',
    '',
    '    wire [31:0] macroscopic_pc;',
    '',
    '    wire [31:0] i_inst_addr;',
    '    wire [31:0] i_inst_rdata;',
    '',
    '    wire [31:0] m_data_addr;',
    '    wire [31:0] m_data_rdata;',
    '    wire [31:0] m_data_wdata;',
    '    wire [3 :0] m_data_byteen;',
    '',
    '    wire [31:0] m_int_addr;',
    '    wire [3 :0] m_int_byteen;',
    '',
    '    wire [31:0] m_inst_addr;',
    '',
    '    wire        w_grf_we;',
    '    wire [4 :0] w_grf_addr;',
    '    wire [31:0] w_grf_wdata;',
    '',
    '    wire [31:0] w_inst_addr;',
    '',
    `    ${topModuleName} uut(`,
    '        .clk(clk),',
    '        .reset(reset),',
    '        .interrupt(interrupt),',
    '        .macroscopic_pc(macroscopic_pc),',
    '',
    '        .i_inst_addr(i_inst_addr),',
    '        .i_inst_rdata(i_inst_rdata),',
    '',
    '        .m_data_addr(m_data_addr),',
    '        .m_data_rdata(m_data_rdata),',
    '        .m_data_wdata(m_data_wdata),',
    '        .m_data_byteen(m_data_byteen),',
    '',
    '        .m_int_addr(m_int_addr),',
    '        .m_int_byteen(m_int_byteen),',
    '',
    '        .m_inst_addr(m_inst_addr),',
    '',
    '        .w_grf_we(w_grf_we),',
    '        .w_grf_addr(w_grf_addr),',
    '        .w_grf_wdata(w_grf_wdata),',
    '',
    '        .w_inst_addr(w_inst_addr)',
    '    );',
    '',
    '    initial begin',
    '        clk <= 0;',
    '        reset <= 1;',
    '        interrupt <= 0;',
    '        #20 reset <= 0;',
    '    end',
    '',
    '    integer i;',
    '    reg [31:0] fixed_addr;',
    '    reg [31:0] fixed_wdata;',
    '    reg [31:0] data[0:4095];',
    '    reg [31:0] inst[0:5119];',
    '',
    '    // ----------- For Instructions -----------',
    '',
    "    assign m_data_rdata = data[(m_data_addr >> 2) % 5120];",
    "    assign i_inst_rdata = inst[((i_inst_addr - 32'h3000) >> 2) % 5120];",
    '',
    '    initial begin',
    '        $readmemh("code.txt", inst);',
    '        for (i = 0; i < 5120; i = i + 1) data[i] <= 0;',
    '    end',
    '',
    '    // ----------- For Data Memory -----------',
    '',
    '    always @(*) begin',
    '        fixed_wdata = data[(m_data_addr >> 2) & 4095];',
    "        fixed_addr = m_data_addr & 32'hfffffffc;",
    '        if (m_data_byteen[3]) fixed_wdata[31:24] = m_data_wdata[31:24];',
    '        if (m_data_byteen[2]) fixed_wdata[23:16] = m_data_wdata[23:16];',
    '        if (m_data_byteen[1]) fixed_wdata[15: 8] = m_data_wdata[15: 8];',
    '        if (m_data_byteen[0]) fixed_wdata[7 : 0] = m_data_wdata[7 : 0];',
    '    end',
    '',
    '    always @(posedge clk) begin',
    '        if (reset) for (i = 0; i < 4096; i = i + 1) data[i] <= 0;',
    '        else if (|m_data_byteen && fixed_addr >> 2 < 4096) begin',
    '            data[fixed_addr >> 2] <= fixed_wdata;',
    '            $display("%d@%h: *%h <= %h", $time, m_inst_addr, fixed_addr, fixed_wdata);',
    '        end',
    '    end',
    '',
    '    // ----------- For Registers -----------',
    '',
    '    always @(posedge clk) begin',
    '        if (~reset) begin',
    '            if (w_grf_we && (w_grf_addr != 0)) begin',
    '                $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);',
    '            end',
    '        end',
    '    end',
    '',
    ...p7InterruptBlock(interruptSchedule),
    '',
    '    always #2 clk <= ~clk;',
    '',
    'endmodule',
    ''
  ].join('\n');
}

function p7InterruptBlock(interruptSchedule?: number[]): string[] {
  const target = interruptSchedule?.find((pc) => Number.isFinite(pc));
  if (target === undefined) {
    return commentedP7InterruptBlock();
  }
  const targetHex = (target >>> 0).toString(16).padStart(8, '0');
  // Official tb_interrupt_demo.v interrupt block: raise `interrupt` once when the
  // macroscopic (M-stage) PC reaches target_pc, clear it when the handler writes 0x7f20.
  return [
    '    // ----------- For Interrupt -----------',
    '',
    '    wire [31:0] fixed_macroscopic_pc;',
    '',
    "    assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;",
    '',
    `    parameter target_pc = 32'h${targetHex};`,
    '',
    '    integer count;',
    '',
    '    initial begin',
    '        count = 0;',
    '    end',
    '',
    '    always @(negedge clk) begin',
    '        if (reset) begin',
    '            interrupt = 0;',
    '        end',
    '        else begin',
    '            if (interrupt) begin',
    "                if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == 32'h7f20) begin",
    '                    interrupt = 0;',
    '                end',
    '            end',
    '            else if (fixed_macroscopic_pc == target_pc) begin',
    '                if (count == 0) begin',
    '                    count = 1;',
    '                    interrupt = 1;',
    '                end',
    '            end',
    '        end',
    '    end'
  ];
}

function commentedP7InterruptBlock(): string[] {
  return [
    '    // ----------- For Interrupt -----------',
    '    //',
    '    // wire [31:0] fixed_macroscopic_pc;',
    '    //',
    "    // assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;",
    '    //',
    "    // parameter target_pc = 32'h00003010;",
    '    //',
    '    // integer count;',
    '    //',
    '    // initial begin',
    '    //     count = 0;',
    '    // end',
    '    //',
    '    // always @(negedge clk) begin',
    '    //     if (reset) begin',
    '    //         interrupt = 0;',
    '    //     end',
    '    //     else begin',
    '    //         if (interrupt) begin',
    "    //             if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == 32'h7f20) begin",
    '    //                 interrupt = 0;',
    '    //             end',
    '    //         end',
    '    //         else if (fixed_macroscopic_pc == target_pc) begin',
    '    //             if (count == 0) begin',
    '    //                 count = 1;',
    '    //                 interrupt = 1;',
    '    //             end',
    '    //         end',
    '    //     end',
    '    // end'
  ];
}

function testbenchSignalKind(port: VerilogDecl, hasExternalMemory: boolean): 'reg' | 'wire' {
  if (port.direction === 'output' || port.direction === 'inout') {
    return 'wire';
  }
  if (hasExternalMemory && (port.name === 'i_inst_rdata' || port.name === 'm_data_rdata')) {
    return 'wire';
  }
  return 'reg';
}

function hasPort(module: VerilogModule, name: string): boolean {
  return module.ports.some((port) => port.name === name);
}

function courseExternalInitialLines(module: VerilogModule, hasClk: boolean, hasReset: boolean): string[] {
  const lines = ['    initial begin'];
  if (hasClk) {
    lines.push("        clk = 1'b0;");
  }
  if (hasReset) {
    lines.push("        reset = 1'b1;");
  }
  for (const port of module.ports) {
    if (port.direction !== 'input' || courseDrivenInputSignals.has(port.name)) {
      continue;
    }
    lines.push(`        ${port.name} = 0;`);
  }
  if (hasReset) {
    lines.push('        #20;', "        reset = 1'b0;");
  }
  lines.push('    end');
  return lines;
}

const courseDrivenInputSignals = new Set(['clk', 'reset', 'i_inst_rdata', 'm_data_rdata']);

function externalMemoryInitialLines(hasInstructionMemory: boolean, hasDataMemory: boolean, isP7ExternalInterface: boolean): string[] {
  const lines = ['    initial begin'];
  if (hasInstructionMemory) {
    lines.push('        $readmemh("code.txt", inst);');
  }
  if (hasDataMemory) {
    lines.push(`        for (i = 0; i < ${isP7ExternalInterface ? 5120 : 4096}; i = i + 1) begin`, '            data[i] <= 0;', '        end');
  }
  lines.push('    end');
  return lines;
}

function externalDataMemoryWriteLines(hasReset: boolean, isP7ExternalInterface: boolean, hasDataMemoryTrace: boolean): string[] {
  const fixedReadIndex = isP7ExternalInterface ? '(m_data_addr >> 2) & 4095' : 'm_data_addr >> 2';
  const writeCondition = isP7ExternalInterface ? '|m_data_byteen && fixed_addr >> 2 < 4096' : '|m_data_byteen';
  const lines = ['    always @(posedge clk) begin'];
  const combinational = [
    '    always @(*) begin',
    `        fixed_wdata = data[${fixedReadIndex}];`,
    "        fixed_addr = m_data_addr & 32'hfffffffc;",
    '        if (m_data_byteen[3]) fixed_wdata[31:24] = m_data_wdata[31:24];',
    '        if (m_data_byteen[2]) fixed_wdata[23:16] = m_data_wdata[23:16];',
    '        if (m_data_byteen[1]) fixed_wdata[15:8] = m_data_wdata[15:8];',
    '        if (m_data_byteen[0]) fixed_wdata[7:0] = m_data_wdata[7:0];',
    '    end',
    ''
  ];
  if (hasReset) {
    lines.push(
      '        if (reset) begin',
      '            for (i = 0; i < 4096; i = i + 1) begin',
      '                data[i] <= 0;',
      '            end',
      `        end else if (${writeCondition}) begin`
    );
  } else {
    lines.push(`        if (${writeCondition}) begin`);
  }
  lines.push('            data[fixed_addr >> 2] <= fixed_wdata;');
  if (hasDataMemoryTrace) {
    lines.push('            $display("%d@%h: *%h <= %h", $time, m_inst_addr, fixed_addr, fixed_wdata);');
  }
  lines.push('        end', '    end');
  return [...combinational, ...lines];
}

function writebackTraceLines(hasReset: boolean): string[] {
  const lines = [
    '    always @(posedge clk) begin',
  ];
  if (hasReset) {
    lines.push(
      '        if (!reset) begin',
      '            if (w_grf_we && (w_grf_addr != 0)) begin',
      '                $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);',
      '            end',
      '        end',
      '    end'
    );
    return lines;
  }
  lines.push(
    '        if (w_grf_we && (w_grf_addr != 0)) begin',
    '            $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);',
    '        end',
    '    end'
  );
  return lines;
}
