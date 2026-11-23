    function co_probe_forbidden_pc;
        input [31:0] pc;
        begin
            case (pc)
                ${forbiddenPcs}: co_probe_forbidden_pc = 1;
                default: co_probe_forbidden_pc = 0;
            endcase
        end
    endfunction

    always @(posedge clk) begin
        if (!reset && ((w_grf_we && w_grf_addr != 0 && co_probe_forbidden_pc(w_inst_addr))
            || (|m_data_byteen && (m_data_addr >> 2) < ${dataMemoryWords} && co_probe_forbidden_pc(m_inst_addr)))) begin
            // Keep the current edge's public write in stdout before ending a looping DUT.
            #1;
            $finish;
        end
    end
