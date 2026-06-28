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
${externalLegacyRaiseBlock}
${externalArmedRaiseBlock}
        end
    end

${externalArmObserverBlock}

${mmioObserverBlock}
