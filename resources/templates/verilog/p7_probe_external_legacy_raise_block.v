            else if (co_p7_external_target != 0 && co_p7_external_legacy && fixed_macroscopic_pc == co_p7_external_target) begin
                $display("CO_P7_PROBE external_raise scenario=%0d pc=%h time=%0d", co_p7_external_scenario, fixed_macroscopic_pc, $time);
                interrupt = 1;
            end
