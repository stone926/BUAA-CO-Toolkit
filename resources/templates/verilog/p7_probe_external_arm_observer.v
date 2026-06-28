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
