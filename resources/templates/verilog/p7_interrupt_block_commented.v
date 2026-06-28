    // ----------- For Interrupt -----------
    //
    // wire [31:0] fixed_macroscopic_pc;
    //
    // assign fixed_macroscopic_pc = macroscopic_pc & 32'hfffffffc;
    //
    // parameter target_pc = 32'h00003010;
    //
    // integer count;
    //
    // initial begin
    //     count = 0;
    // end
    //
    // always @(negedge clk) begin
    //     if (reset) begin
    //         interrupt = 0;
    //     end
    //     else begin
    //         if (interrupt) begin
    //             if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == ${externalInterruptAckAddress}) begin
    //                 interrupt = 0;
    //             end
    //         end
    //         else if (fixed_macroscopic_pc == target_pc) begin
    //             if (count == 0) begin
    //                 count = 1;
    //                 interrupt = 1;
    //             end
    //         end
    //     end
    // end
