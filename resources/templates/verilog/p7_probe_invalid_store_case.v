                32'h${victimPcHex}: begin
                    if (m_data_byteen !== 4'b0000 || m_int_byteen !== 4'b0000) begin
                        $display("CO_P7_PROBE invalid_store_effect scenario=${scenarioId} pc=%h data_byteen=%h int_byteen=%h time=%0d", m_inst_addr, m_data_byteen, m_int_byteen, $time);
                    end
                end
