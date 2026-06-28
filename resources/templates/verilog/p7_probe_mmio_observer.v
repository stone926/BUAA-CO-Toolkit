    always @(posedge clk) begin
        if (~reset && |m_data_byteen && fixed_addr >= ${timer0CtrlAddress} && fixed_addr <= ${externalInterruptMmioMaxAddress}) begin
            $display("CO_P7_PROBE mmio_on_dm pc=%h addr=%h byteen=%h time=%0d", m_inst_addr, fixed_addr, m_data_byteen, $time);
        end
    end
