    always @(posedge clk) begin
        if (~reset) begin
            case (m_inst_addr)
${invalidStoreVictimCases}
                default: begin end
            endcase
        end
    end
