mtc0 $0, $12
sw $0, ${timer0CtrlHex}($0)
sw $0, ${timer1CtrlHex}($0)
sw $0, ${externalArmAddressHex}($0)
${loadProbeLogBase}
sw $26, ${stateRecordPtrHex}($0)
sw $0, ${stateScenarioIdHex}($0)
sw $0, ${stateKindHex}($0)
sw $0, ${stateDonePcHex}($0)
sw $0, ${stateFlagsHex}($0)
sw $0, ${stateFirstStatusHex}($0)
sw $0, ${stateFirstCauseHex}($0)
sw $0, ${stateFirstEpcHex}($0)
