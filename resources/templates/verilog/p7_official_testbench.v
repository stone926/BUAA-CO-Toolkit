`timescale 1ns/1ps

module ${tbName};

    reg clk;
    reg reset;
    reg interrupt;

    wire [31:0] macroscopic_pc;

    wire [31:0] i_inst_addr;
    wire [31:0] i_inst_rdata;

    wire [31:0] m_data_addr;
    wire [31:0] m_data_rdata;
    wire [31:0] m_data_wdata;
    wire [3 :0] m_data_byteen;

    wire [31:0] m_int_addr;
    wire [3 :0] m_int_byteen;

    wire [31:0] m_inst_addr;

    wire        w_grf_we;
    wire [4 :0] w_grf_addr;
    wire [31:0] w_grf_wdata;

    wire [31:0] w_inst_addr;

    ${topModuleName} uut(
        .clk(clk),
        .reset(reset),
        .interrupt(interrupt),
        .macroscopic_pc(macroscopic_pc),

        .i_inst_addr(i_inst_addr),
        .i_inst_rdata(i_inst_rdata),

        .m_data_addr(m_data_addr),
        .m_data_rdata(m_data_rdata),
        .m_data_wdata(m_data_wdata),
        .m_data_byteen(m_data_byteen),

        .m_int_addr(m_int_addr),
        .m_int_byteen(m_int_byteen),

        .m_inst_addr(m_inst_addr),

        .w_grf_we(w_grf_we),
        .w_grf_addr(w_grf_addr),
        .w_grf_wdata(w_grf_wdata),

        .w_inst_addr(w_inst_addr)
    );

    initial begin
        clk <= 0;
        reset <= 1;
        interrupt <= 0;
        #20 reset <= 0;
    end

    integer i;
    reg [31:0] fixed_addr;
    reg [31:0] fixed_wdata;
    reg [31:0] data[0:${dataMemoryLastIndex}];
    reg [31:0] inst[0:${instructionMemoryLastIndex}];

    // ----------- For Instructions -----------

    assign m_data_rdata = data[(m_data_addr >> 2) % ${dataMemoryWords}];
    assign i_inst_rdata = inst[((i_inst_addr - ${userTextBase}) >> 2) % ${instructionMemoryWords}];

    initial begin
        $readmemh("code.txt", inst);
        for (i = 0; i < ${dataMemoryWords}; i = i + 1) data[i] <= 0;
    end

    // ----------- For Data Memory -----------

    always @(*) begin
        fixed_wdata = data[(m_data_addr >> 2) % ${dataMemoryWords}];
        fixed_addr = m_data_addr & 32'hfffffffc;
        if (m_data_byteen[3]) fixed_wdata[31:24] = m_data_wdata[31:24];
        if (m_data_byteen[2]) fixed_wdata[23:16] = m_data_wdata[23:16];
        if (m_data_byteen[1]) fixed_wdata[15: 8] = m_data_wdata[15: 8];
        if (m_data_byteen[0]) fixed_wdata[7 : 0] = m_data_wdata[7 : 0];
    end

    always @(posedge clk) begin
        if (reset) for (i = 0; i < ${dataMemoryWords}; i = i + 1) data[i] <= 0;
        else if (|m_data_byteen && fixed_addr >> 2 < ${dataMemoryWords}) begin
            data[fixed_addr >> 2] <= fixed_wdata;
            $display("%d@%h: *%h <= %h", $time, m_inst_addr, fixed_addr, fixed_wdata);
        end
    end

${storeContractBlock}
    // ----------- For Registers -----------

    always @(posedge clk) begin
        if (~reset) begin
            if (w_grf_we && (w_grf_addr != 0)) begin
                $display("%d@%h: $%d <= %h", $time, w_inst_addr, w_grf_addr, w_grf_wdata);
            end
        end
    end

${interruptBlock}

    // The macro PC may stay on an instruction during stalls. Observe a full
    // branch / delay slot / branch traversal independently of its cycle count.
    reg [31:0] co_halt_pc;
    integer co_halt_phase;
    integer co_observe_halt;
    initial begin
        co_observe_halt = $value$plusargs("co_halt_pc=%h", co_halt_pc);
        co_halt_phase = 0;
    end
    always @(negedge clk) begin
        if (reset) co_halt_phase = 0;
        else if (co_observe_halt && co_halt_phase < 3) begin
            if (macroscopic_pc === co_halt_pc) begin
                if (co_halt_phase == 2) begin
                    co_halt_phase = 3;
                    $display("CO_P7_HALT pc=%08h", co_halt_pc);
                    $finish;
                end else co_halt_phase = 1;
            end else if (macroscopic_pc === co_halt_pc + 4 && co_halt_phase != 0)
                co_halt_phase = 2;
            else co_halt_phase = 0;
        end
    end

    always #2 clk <= ~clk;

endmodule
