    // ----------- For Interrupt -----------

    reg [${lastTargetIndex}:0] co_irq_fired;
    integer co_irq_index;
    always @(*) begin
        case (macroscopic_pc)
${targetCases}
            default: co_irq_index = -1;
        endcase
    end

    always @(negedge clk) begin
        if (reset) begin
            interrupt = 0;
            co_irq_fired = 0;
        end
        else begin
            if (interrupt) begin
                if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == ${externalInterruptAckAddress}) begin
                    interrupt = 0;
                end
            end
            else if (co_irq_index >= 0 && !co_irq_fired[co_irq_index]) begin
                co_irq_fired[co_irq_index] = 1;
                interrupt = 1;
            end
        end
    end
