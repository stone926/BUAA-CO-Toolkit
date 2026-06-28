            ${index}: begin
                co_p7_external_scenario = ${scenarioId};
                co_p7_external_target = 32'h${targetPcHex};
                co_p7_external_arm_addr = 32'h${armAddressHex};
                co_p7_external_arm_value = 32'h${armValueHex};
                co_p7_external_delay = ${delayCycles};
                co_p7_external_legacy = ${legacyFlag};
            end
