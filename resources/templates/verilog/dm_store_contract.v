    // Public DM write contract. A retained M-stage PC alone does not make a
    // transaction valid; idle/load cycles and disabled data lanes are ignored.
    // Preserve the raw bus facts alongside the canonical merged-word trace.
    reg [31:0] co_dm_store_instruction;
    reg [3:0] co_dm_expected_byteen;
    integer co_dm_lane;

    always @(posedge clk) begin
        if (${activeCondition}(|m_data_byteen === 1'b1)) begin
            $display("CO_DM_STORE pc=%h addr=%h word=%h byteen=%b wdata=%h time=%0t", m_inst_addr, m_data_addr, {m_data_addr[31:2], 2'b00}, m_data_byteen, m_data_wdata, $time);
            // Only the word-selecting address bits are always meaningful.
            // SW ignores both low bits; SH ignores bit 0 (P6 byte-enable table).
            if ((^m_data_addr[31:2] === 1'bx) || {m_data_addr[31:2], 2'b00} >= ${dataMemoryBytes})
                $fatal(1, "CO_DM_CONTRACT invalid_address pc=%h addr=%h byteen=%b wdata=%h", m_inst_addr, m_data_addr, m_data_byteen, m_data_wdata);
            if ((^m_inst_addr === 1'bx) || (m_inst_addr[1:0] !== 2'b00)
                || m_inst_addr < ${userTextBase} || ((m_inst_addr - ${userTextBase}) >> 2) >= ${instructionMemoryWords})
                $fatal(1, "CO_DM_CONTRACT invalid_pc pc=%h addr=%h byteen=%b wdata=%h", m_inst_addr, m_data_addr, m_data_byteen, m_data_wdata);

            co_dm_store_instruction = inst[(m_inst_addr - ${userTextBase}) >> 2];
            case (co_dm_store_instruction[31:26])
                6'h28, 6'h2a, 6'h2e: begin
                    if (^m_data_addr[1:0] === 1'bx)
                        $fatal(1, "CO_DM_CONTRACT invalid_address pc=%h addr=%h byteen=%b wdata=%h", m_inst_addr, m_data_addr, m_data_byteen, m_data_wdata);
                end
                6'h29: begin
                    if (m_data_addr[1] !== 1'b0 && m_data_addr[1] !== 1'b1)
                        $fatal(1, "CO_DM_CONTRACT invalid_address pc=%h addr=%h byteen=%b wdata=%h", m_inst_addr, m_data_addr, m_data_byteen, m_data_wdata);
                end
            endcase
            // Little-endian byte enables; SWL/SWR also support the extension's
            // optional instruction set. The base course uses SB/SH/SW.
            case (co_dm_store_instruction[31:26])
                6'h28: co_dm_expected_byteen = 4'b0001 << m_data_addr[1:0]; // sb
                6'h29: co_dm_expected_byteen = m_data_addr[1] ? 4'b1100 : 4'b0011; // sh
                6'h2b: co_dm_expected_byteen = 4'b1111; // sw
                6'h2a: co_dm_expected_byteen = 4'b1111 >> (3 - m_data_addr[1:0]); // swl
                6'h2e: co_dm_expected_byteen = 4'b1111 << m_data_addr[1:0]; // swr
                default: begin
                    co_dm_expected_byteen = 4'b0000;
                    $fatal(1, "CO_DM_CONTRACT non_store_instruction pc=%h instruction=%h addr=%h byteen=%b wdata=%h", m_inst_addr, co_dm_store_instruction, m_data_addr, m_data_byteen, m_data_wdata);
                end
            endcase
            if (m_data_byteen !== co_dm_expected_byteen)
                $fatal(1, "CO_DM_CONTRACT byte_enable pc=%h instruction=%h addr=%h byteen=%b expected=%b wdata=%h", m_inst_addr, co_dm_store_instruction, m_data_addr, m_data_byteen, co_dm_expected_byteen, m_data_wdata);
            for (co_dm_lane = 0; co_dm_lane < 4; co_dm_lane = co_dm_lane + 1) begin
                if (m_data_byteen[co_dm_lane] && (^m_data_wdata[co_dm_lane * 8 +: 8] === 1'bx))
                    $fatal(1, "CO_DM_CONTRACT unknown_enabled_lane pc=%h addr=%h byteen=%b lane=%0d wdata=%h", m_inst_addr, m_data_addr, m_data_byteen, co_dm_lane, m_data_wdata);
            end
        end
    end
