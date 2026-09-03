.ktext ${exceptionHandlerHex}
_co_probe_handler:
    mfc0 $24, $13
    mfc0 $25, $12
    mfc0 $23, $14
    andi $26, $24, ${excCodeMaskHex}
    bne $26, $0, _co_probe_record_internal
    nop
    lw $22, ${stateFlagsHex}($0)
    andi $26, $22, ${probeFlagRepeatTimerInterrupt}
    beq $26, $0, _co_probe_clear_interrupt_sources
    nop
    andi $26, $22, ${probeFlagRepeatTimerCaptured}
    bne $26, $0, _co_probe_check_repeat_timer_fresh
    nop
    sw $25, ${stateFirstStatusHex}($0)
    sw $24, ${stateFirstCauseHex}($0)
    sw $23, ${stateFirstEpcHex}($0)
    ori $22, $22, ${probeFlagRepeatTimerCaptured}
    sw $22, ${stateFlagsHex}($0)
    lw $27, ${stateKindHex}($0)
    ori $26, $0, ${probeKindTimer1}
    beq $27, $26, _co_probe_mask_repeat_timer1
    nop
    ori $26, $0, 3
    sw $26, ${timer0CtrlHex}($0)
    beq $0, $0, _co_probe_resume_repeat_timer_followup
    nop
_co_probe_mask_repeat_timer1:
    ori $26, $0, 3
    sw $26, ${timer1CtrlHex}($0)
_co_probe_resume_repeat_timer_followup:
    lw $23, ${stateDonePcHex}($0)
    mtc0 $23, $14
    eret
    sw $0, ${eretPoisonAddressHex}($0)
_co_probe_check_repeat_timer_fresh:
    andi $26, $22, ${probeFlagRepeatTimerFreshArmed}
    bne $26, $0, _co_probe_record_repeat_timer_interrupt
    nop
    lui $26, ${mode1FailureMarkerHiHex}
    ori $26, $26, ${mode1FailureMarkerLoHex}
    sw $26, ${mode1MarkerAddressHex}($0)
_co_probe_stale_repeat_timer_interrupt:
    beq $0, $0, _co_probe_stale_repeat_timer_interrupt
    nop
_co_probe_clear_interrupt_sources:
    ori $20, $0, 0
    ori $21, $0, 0
    andi $26, $24, ${causeIpTimer0MaskHex}
    beq $26, $0, _co_probe_check_timer1
    nop
    lw $20, ${timer0CtrlHex}($0)
    lw $21, ${timer0CountHex}($0)
    sw $0, ${timer0CtrlHex}($0)
_co_probe_check_timer1:
    andi $26, $24, ${causeIpTimer1MaskHex}
    beq $26, $0, _co_probe_check_external
    nop
    lw $20, ${timer1CtrlHex}($0)
    lw $21, ${timer1CountHex}($0)
    sw $0, ${timer1CtrlHex}($0)
_co_probe_check_external:
    andi $26, $24, ${causeIpExternalMaskHex}
    beq $26, $0, _co_probe_check_priority_interrupt
    nop
    sb $0, ${externalInterruptAckHex}($0)
_co_probe_check_priority_interrupt:
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagResumeInterruptEpc}
    bne $22, $0, _co_probe_capture_priority_interrupt
    nop
_co_probe_record_interrupt:
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordHiLo}
    beq $22, $0, _co_probe_write_interrupt_record
    nop
    mfhi $20
    mflo $21
_co_probe_write_interrupt_record:
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
    sw $20, 24($26)
    sw $21, 28($26)
_co_probe_record_done:
    addi $26, $26, ${recordByteLength}
    sw $26, ${stateRecordPtrHex}($0)
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRetryInterruptEpc}
    bne $22, $0, _co_probe_eret_current_epc
    nop
    lw $23, ${stateDonePcHex}($0)
    mtc0 $23, $14
_co_probe_eret_current_epc:
    eret
    sw $0, ${eretPoisonAddressHex}($0)
_co_probe_capture_priority_interrupt:
    sw $25, ${stateFirstStatusHex}($0)
    sw $24, ${stateFirstCauseHex}($0)
    sw $23, ${stateFirstEpcHex}($0)
    eret
    sw $0, ${eretPoisonAddressHex}($0)
_co_probe_record_repeat_timer_interrupt:
    lw $27, ${stateKindHex}($0)
    ori $26, $0, ${probeKindTimer1}
    beq $27, $26, _co_probe_clear_repeat_timer1
    nop
    sw $0, ${timer0CtrlHex}($0)
    beq $0, $0, _co_probe_write_repeat_timer_record
    nop
_co_probe_clear_repeat_timer1:
    sw $0, ${timer1CtrlHex}($0)
_co_probe_write_repeat_timer_record:
    lw $26, ${stateRecordPtrHex}($0)
    lui $27, ${magicHiHex}
    ori $27, $27, ${magicLoHex}
    sw $27, 0($26)
    sw $25, ${replayStatusAddressHex}($0)
    lw $27, ${stateScenarioIdHex}($0)
    sw $27, 4($26)
    lw $27, ${stateKindHex}($0)
    sw $27, 8($26)
    lw $27, ${stateFirstStatusHex}($0)
    sw $27, 12($26)
    lw $27, ${stateFirstCauseHex}($0)
    sw $27, 16($26)
    lw $27, ${stateFirstEpcHex}($0)
    sw $27, 20($26)
    sw $24, 24($26)
    sw $23, 28($26)
    addi $26, $26, ${recordByteLength}
    sw $26, ${stateRecordPtrHex}($0)
    lw $23, ${stateDonePcHex}($0)
    mtc0 $23, $14
    eret
    sw $0, ${eretPoisonAddressHex}($0)
_co_probe_record_internal:
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagResumeInterruptEpc}
    bne $22, $0, _co_probe_record_priority_exception
    nop
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
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordHiLo}
    bne $22, $0, _co_probe_internal_aux_hilo
    nop
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordTimer0Ctrl}
    bne $22, $0, _co_probe_internal_aux_timer0_ctrl
    nop
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordTimer0Preset}
    bne $22, $0, _co_probe_internal_aux_timer0_preset
    nop
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordTimer0Count}
    bne $22, $0, _co_probe_internal_aux_timer0_count
    nop
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordTimer1Ctrl}
    bne $22, $0, _co_probe_internal_aux_timer1_ctrl
    nop
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordTimer1Preset}
    bne $22, $0, _co_probe_internal_aux_timer1_preset
    nop
    lw $22, ${stateFlagsHex}($0)
    andi $22, $22, ${probeFlagRecordTimer1Count}
    bne $22, $0, _co_probe_internal_aux_timer1_count
    nop
    beq $0, $0, _co_probe_internal_aux_zero
    nop
_co_probe_internal_aux_hilo:
    mfhi $22
    sw $22, 24($26)
    mflo $22
    sw $22, 28($26)
    beq $0, $0, _co_probe_internal_record_done
    nop
_co_probe_internal_aux_timer0_ctrl:
    sw $21, 24($26)
    lw $22, ${timer0CtrlHex}($0)
    sw $22, 28($26)
    beq $0, $0, _co_probe_internal_record_done
    nop
_co_probe_internal_aux_timer0_preset:
    sw $21, 24($26)
    lw $22, ${timer0PresetHex}($0)
    sw $22, 28($26)
    beq $0, $0, _co_probe_internal_record_done
    nop
_co_probe_internal_aux_timer0_count:
    sw $21, 24($26)
    lw $22, ${timer0CountHex}($0)
    sw $22, 28($26)
    beq $0, $0, _co_probe_internal_record_done
    nop
_co_probe_internal_aux_timer1_ctrl:
    sw $21, 24($26)
    lw $22, ${timer1CtrlHex}($0)
    sw $22, 28($26)
    beq $0, $0, _co_probe_internal_record_done
    nop
_co_probe_internal_aux_timer1_preset:
    sw $21, 24($26)
    lw $22, ${timer1PresetHex}($0)
    sw $22, 28($26)
    beq $0, $0, _co_probe_internal_record_done
    nop
_co_probe_internal_aux_timer1_count:
    sw $21, 24($26)
    lw $22, ${timer1CountHex}($0)
    sw $22, 28($26)
    beq $0, $0, _co_probe_internal_record_done
    nop
_co_probe_internal_aux_zero:
    sw $0, 24($26)
    sw $0, 28($26)
_co_probe_internal_record_done:
    addi $26, $26, ${recordByteLength}
    sw $26, ${stateRecordPtrHex}($0)
    lw $23, ${stateDonePcHex}($0)
    mtc0 $23, $14
    eret
    sw $0, ${eretPoisonAddressHex}($0)
_co_probe_record_priority_exception:
    lw $26, ${stateRecordPtrHex}($0)
    lui $27, ${magicHiHex}
    ori $27, $27, ${magicLoHex}
    sw $27, 0($26)
    sw $25, ${replayStatusAddressHex}($0)
    lw $27, ${stateScenarioIdHex}($0)
    sw $27, 4($26)
    lw $27, ${stateKindHex}($0)
    sw $27, 8($26)
    lw $27, ${stateFirstStatusHex}($0)
    sw $27, 12($26)
    lw $27, ${stateFirstCauseHex}($0)
    sw $27, 16($26)
    lw $27, ${stateFirstEpcHex}($0)
    sw $27, 20($26)
    sw $24, 24($26)
    sw $23, 28($26)
    addi $26, $26, ${recordByteLength}
    sw $26, ${stateRecordPtrHex}($0)
    lw $23, ${stateDonePcHex}($0)
    mtc0 $23, $14
    eret
    sw $0, ${eretPoisonAddressHex}($0)
_co_probe_priority_release:
    eret
    sw $0, ${eretPoisonAddressHex}($0)
