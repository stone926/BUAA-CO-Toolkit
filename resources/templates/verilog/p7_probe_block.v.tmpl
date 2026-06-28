    // ----------- For P7 Probe Interrupt -----------

    wire [31:0] fixed_macroscopic_pc;

    assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;

    integer co_p7_external_index;
    integer co_p7_external_scenario;
    integer co_p7_external_delay;
    integer co_p7_external_wait_count;
    reg [31:0] co_p7_external_target;
    reg [31:0] co_p7_external_arm_addr;
    reg [31:0] co_p7_external_arm_value;
    reg co_p7_external_armed;
    reg co_p7_external_legacy;

    initial begin
        co_p7_external_index = 0;
        co_p7_external_scenario = 0;
        co_p7_external_delay = 0;
        co_p7_external_wait_count = 0;
        co_p7_external_target = 0;
        co_p7_external_arm_addr = 0;
        co_p7_external_arm_value = 0;
        co_p7_external_armed = 0;
        co_p7_external_legacy = 0;
    end

    always @(*) begin
        co_p7_external_scenario = 0;
        co_p7_external_delay = 0;
        co_p7_external_target = 0;
        co_p7_external_arm_addr = 0;
        co_p7_external_arm_value = 0;
        co_p7_external_legacy = 0;
        case (co_p7_external_index)
${externalScenarioCases}
            default: begin
                co_p7_external_scenario = 0;
                co_p7_external_target = 0;
            end
        endcase
    end

    always @(negedge clk) begin
        if (reset) begin
            interrupt = 0;
            co_p7_external_index = 0;
            co_p7_external_armed = 0;
            co_p7_external_wait_count = 0;
        end
        else begin
            if (interrupt) begin
                if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == ${externalInterruptAckAddress}) begin
                    $display("CO_P7_PROBE external_ack scenario=%0d time=%0d", co_p7_external_scenario, $time);
                    interrupt = 0;
                    co_p7_external_armed = 0;
                    co_p7_external_wait_count = 0;
                    co_p7_external_index = co_p7_external_index + 1;
                end
            end
            else if (co_p7_external_target != 0 && co_p7_external_legacy && fixed_macroscopic_pc == co_p7_external_target) begin
                $display("CO_P7_PROBE external_raise scenario=%0d pc=%h time=%0d", co_p7_external_scenario, fixed_macroscopic_pc, $time);
                interrupt = 1;
            end
            else if (co_p7_external_target != 0 && co_p7_external_armed && fixed_macroscopic_pc == co_p7_external_target) begin
                if (co_p7_external_wait_count >= co_p7_external_delay) begin
                    $display("CO_P7_PROBE external_raise scenario=%0d pc=%h time=%0d", co_p7_external_scenario, fixed_macroscopic_pc, $time);
                    interrupt = 1;
                    co_p7_external_armed = 0;
                end
                else begin
                    co_p7_external_wait_count = co_p7_external_wait_count + 1;
                end
            end
        end
    end

    always @(posedge clk) begin
        if (reset) begin
            co_p7_external_armed = 0;
            co_p7_external_wait_count = 0;
        end
        else if (co_p7_external_arm_addr != 0 && |m_data_byteen && fixed_addr == co_p7_external_arm_addr && fixed_wdata == co_p7_external_arm_value) begin
            co_p7_external_armed = 1;
            co_p7_external_wait_count = 0;
            $display("CO_P7_PROBE external_arm scenario=%0d addr=%h value=%h time=%0d", co_p7_external_scenario, fixed_addr, fixed_wdata, $time);
        end
    end

    always @(posedge clk) begin
        if (~reset && |m_data_byteen && fixed_addr >= ${timer0CtrlAddress} && fixed_addr <= ${externalInterruptMmioMaxAddress}) begin
            $display("CO_P7_PROBE mmio_on_dm pc=%h addr=%h byteen=%h time=%0d", m_inst_addr, fixed_addr, m_data_byteen, $time);
        end
    end
