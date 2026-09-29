    // Two real interrupts. The only handler exit is eret. Per the public
    // macroscopic-PC contract, advancing past that instruction advances the
    // architectural boundary past eret; no CP0 stage or cycle count is assumed.
    integer co_return_phase;
    reg co_return_armed;
    reg [31:0] co_return_last_pc;
    wire [31:0] co_return_macro_pc = macroscopic_pc;

    initial begin
        co_return_phase = 0;
        co_return_armed = 0;
        co_return_last_pc = 32'hffffffff;
    end

    always @(posedge clk) begin
        if (!reset && |m_data_byteen && fixed_addr == ${poisonAddress}) begin
            $display("CO_P7_PROBE invalid_store_effect source=return_poison pc=%h addr=%h time=%0d", m_inst_addr, fixed_addr, $time);
            // A forbidden public write is already a counterexample. Let all
            // current-edge trace observers finish, then avoid unrelated fallout.
            #1;
            $finish;
        end
        if (!reset && co_return_phase == 0 && !co_return_armed
            && m_data_byteen == 4'b1111 && fixed_addr == ${armAddress}
            && m_data_wdata == ${armValue}) begin
            co_return_armed = 1;
            $display("CO_P7_PROBE external_arm scenario=${firstId} time=%0d", $time);
        end
    end

    always @(negedge clk) begin
        if (reset) begin
            interrupt = 0;
            co_return_phase = 0;
            co_return_armed = 0;
            co_return_last_pc = 32'hffffffff;
        end else begin
            // Observe at the official generator's consumption edge, before
            // withdrawing interrupt (the DUT may gate its response by it).
            if (|m_int_byteen && (m_int_addr & 32'hfffffffc) == ${ackAddress}) begin
                $display("CO_P7_PROBE return_ack_store pc=%h addr=%h time=%0d", m_inst_addr, m_int_addr, $time);
                if (m_inst_addr !== ${ackPc}) begin
                    $display("CO_P7_PROBE invalid_store_effect source=interrupt_generator pc=%h addr=%h time=%0d", m_inst_addr, m_int_addr, $time);
                end
            end
            if (co_return_phase == 2 || co_return_phase == 3) begin
                if (co_return_macro_pc !== co_return_last_pc) begin
                    $display("CO_P7_PROBE return_pc scenario=${secondId} pc=%h time=%0d", co_return_macro_pc, $time);
                    co_return_last_pc = co_return_macro_pc;
                end
            end
            if (interrupt && |m_int_byteen && (m_int_addr & 32'hfffffffc) == ${ackAddress}) begin
                if (co_return_phase == 1) begin
                    $display("CO_P7_PROBE external_ack scenario=${firstId} time=%0d", $time);
                    co_return_phase = 2;
                end else if (co_return_phase == 4) begin
                    $display("CO_P7_PROBE external_ack scenario=${secondId} time=%0d", $time);
                    co_return_phase = 5;
                end
                interrupt = 0;
            end else begin
                case (co_return_phase)
                    0: if (co_return_armed && co_return_macro_pc == ${firstTarget}) begin
                        interrupt = 1;
                        co_return_phase = 1;
                        $display("CO_P7_PROBE external_raise scenario=${firstId} time=%0d", $time);
                    end
                    2: if (co_return_macro_pc == ${eretPc}) begin
                        co_return_phase = 3;
                        $display("CO_P7_PROBE return_seen scenario=${secondId} pc=%h time=%0d", co_return_macro_pc, $time);
                    end
                    3: if ((^co_return_macro_pc) !== 1'bx && co_return_macro_pc != ${eretPc}) begin
                        interrupt = 1;
                        co_return_phase = 4;
                        $display("CO_P7_PROBE return_exit scenario=${secondId} pc=%h time=%0d", co_return_macro_pc, $time);
                        $display("CO_P7_PROBE external_raise scenario=${secondId} time=%0d", $time);
                    end
                    default: begin end
                endcase
            end
        end
    end
