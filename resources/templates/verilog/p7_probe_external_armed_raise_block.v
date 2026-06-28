            else if (co_p7_external_target != 0 && co_p7_external_armed && fixed_macroscopic_pc == co_p7_external_target) begin
                if (co_p7_external_wait_count >= co_p7_external_delay) begin
                    $display("CO_P7_PROBE external_raise scenario=%0d pc=%h time=%0d", co_p7_external_scenario, fixed_macroscopic_pc, $time);
                    interrupt = 1;
                    co_p7_external_armed = 0;
                end
                else begin
                    co_p7_external_wait_count = co_p7_external_wait_count + 1;
                end
            end
