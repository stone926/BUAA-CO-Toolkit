.ktext ${exceptionHandlerHex}
_co_probe_handler:
    mfc0 $24, $13
    mfc0 $25, $12
    mfc0 $23, $14
    andi $26, $24, ${excCodeMaskHex}
    bne $26, $0, _co_probe_record_internal
    nop
    andi $26, $24, ${causeIpTimer0MaskHex}
    beq $26, $0, _co_probe_check_timer1
    nop
    sw $0, ${timer0CtrlHex}($0)
_co_probe_check_timer1:
    andi $26, $24, ${causeIpTimer1MaskHex}
    beq $26, $0, _co_probe_check_external
    nop
    sw $0, ${timer1CtrlHex}($0)
_co_probe_check_external:
    andi $26, $24, ${causeIpExternalMaskHex}
    beq $26, $0, _co_probe_record_interrupt
    nop
    sb $0, ${externalInterruptAckHex}($0)
_co_probe_record_interrupt:
    lw $26, ${stateRecordPtrHex}($0)
    lui $27, ${magicHiHex}
    ori $27, $27, ${magicLoHex}
    sw $27, 0($26)
    lw $27, ${stateScenarioIdHex}($0)
    sw $27, 4($26)
    lw $27, ${stateKindHex}($0)
    sw $27, 8($26)
    sw $25, 12($26)
    sw $24, 16($26)
    sw $23, 20($26)
    lw $27, ${stateKindHex}($0)
    ori $22, $0, ${probeKindTimer1}
    beq $27, $22, _co_probe_aux_timer1
    nop
    lw $22, ${timer0CtrlHex}($0)
    sw $22, 24($26)
    lw $22, ${timer0CountHex}($0)
    sw $22, 28($26)
    beq $0, $0, _co_probe_record_done
    nop
_co_probe_aux_timer1:
    lw $22, ${timer1CtrlHex}($0)
    sw $22, 24($26)
    lw $22, ${timer1CountHex}($0)
    sw $22, 28($26)
_co_probe_record_done:
    addi $26, $26, ${recordByteLength}
    sw $26, ${stateRecordPtrHex}($0)
    lw $23, ${stateDonePcHex}($0)
    mtc0 $23, $14
    eret
_co_probe_record_internal:
    lw $26, ${stateRecordPtrHex}($0)
    lui $27, ${magicHiHex}
    ori $27, $27, ${magicLoHex}
    sw $27, 0($26)
    lw $27, ${stateScenarioIdHex}($0)
    sw $27, 4($26)
    lw $27, ${stateKindHex}($0)
    sw $27, 8($26)
    sw $25, 12($26)
    sw $24, 16($26)
    sw $23, 20($26)
    sw $0, 24($26)
    sw $0, 28($26)
    addi $26, $26, ${recordByteLength}
    sw $26, ${stateRecordPtrHex}($0)
    addi $23, $23, 4
    mtc0 $23, $14
    eret
