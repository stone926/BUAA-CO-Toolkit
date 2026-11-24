    // Two real interrupts. The only handler exit is eret. Per the public
    // macroscopic-PC contract, advancing past that instruction advances the
    // architectural boundary past eret; no CP0 stage or cycle count is assumed.
    integer co_return_phase;
    integer co_reset_phase;
    reg co_return_record_complete;
    reg [31:0] co_return_last_pc;
    wire [31:0] co_return_macro_pc = macroscopic_pc;

    initial begin
        co_return_phase = 0;
        co_reset_phase = ${resetAtFirstIrq};
        co_return_record_complete = 0;
        co_return_last_pc = 32'hffffffff;
    end

    always @(posedge clk) begin
        // The handler writes the end of its DM record before issuing the IG
        // store. This is a separate public transaction completed at a posedge.
        if (!reset && m_data_byteen == 4'b1111 && m_data_wdata == 0
            && ((co_return_phase == 1 && fixed_addr == ${firstRecordTail})
                || (co_return_phase == 4 && fixed_addr == ${secondRecordTail}))) begin
            co_return_record_complete = 1;
        end
        if (!reset && |m_data_byteen && fixed_addr == ${poisonAddress}) begin
            $display("CO_P7_PROBE invalid_store_effect source=return_poison pc=%h addr=%h time=%0d", m_inst_addr, fixed_addr, $time);
            // A forbidden public write is already a counterexample. Let all
            // current-edge trace observers finish, then avoid unrelated fallout.
            #1;
            $finish;
        end
    end

    always @(negedge clk) begin
        if (reset) begin
            interrupt = 0;
            if (co_reset_phase == 2) begin
                // One active clock edge has sampled reset and interrupt together.
                reset <= 0;
                co_reset_phase = 0;
                $display("CO_P7_RESET_RESTART");
            end
            co_return_phase = 0;
            co_return_record_complete = 0;
            co_return_last_pc = 32'hffffffff;
        end else begin
            if (co_return_phase == 2 || co_return_phase == 3) begin
                if (co_return_macro_pc !== co_return_last_pc) begin
                    $display("CO_P7_PROBE return_pc scenario=${secondId} pc=%h time=%0d", co_return_macro_pc, $time);
                    co_return_last_pc = co_return_macro_pc;
                end
            end
            if (interrupt && |m_int_byteen && (m_int_addr & 32'hfffffffc) == ${ackAddress}) begin
                if (co_return_phase == 1) begin
                    if (!co_return_record_complete)
                        $display("CO_P7_PROBE external_ack_early scenario=${firstId} time=%0d", $time);
                    $display("CO_P7_PROBE external_ack scenario=${firstId} time=%0d", $time);
                    co_return_phase = 2;
                end else if (co_return_phase == 4) begin
                    if (!co_return_record_complete)
                        $display("CO_P7_PROBE external_ack_early scenario=${secondId} time=%0d", $time);
                    $display("CO_P7_PROBE external_ack scenario=${secondId} time=%0d", $time);
                    co_return_phase = 5;
                end
                interrupt = 0;
            end else begin
                case (co_return_phase)
                    // This PC occurs only on the approach to the victim (or its retry).
                    // Its older store can reach the DM port after the PC is sampled.
                    0: if (co_return_macro_pc == ${firstTarget}) begin
                        interrupt = 1;
                        co_return_phase = 1;
                        co_return_record_complete = 0;
                        if (co_reset_phase == 1) begin
                            reset <= 1;
                            co_reset_phase = 2;
                        end
                        $display("CO_P7_PROBE external_raise scenario=${firstId} pc=%h time=%0d", co_return_macro_pc, $time);
                    end
                    3: if ((^co_return_macro_pc) !== 1'bx && co_return_macro_pc != ${eretPc}) begin
                        interrupt = 1;
                        co_return_phase = 4;
                        co_return_record_complete = 0;
                        $display("CO_P7_PROBE return_exit scenario=${secondId} pc=%h time=%0d", co_return_macro_pc, $time);
                        $display("CO_P7_PROBE external_raise scenario=${secondId} pc=%h time=%0d", co_return_macro_pc, $time);
                    end
                    default: begin end
                endcase
            end
            // The bridge may acknowledge on the very edge at which eret is
            // visible. Capture that boundary before the next macro instruction.
            if (co_return_phase == 2 && co_return_macro_pc == ${eretPc}) begin
                co_return_phase = 3;
                $display("CO_P7_PROBE return_seen scenario=${secondId} pc=%h time=%0d", co_return_macro_pc, $time);
            end
        end
    end
