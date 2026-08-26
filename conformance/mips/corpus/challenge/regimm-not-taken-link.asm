.text
    ori   $31, $0, 0x1234
    addiu $t0, $0, -1
    bgezal $t0, not_taken_target
    nop
    sw    $31, 0($0)
_co_test_end:
    beq   $0, $0, _co_test_end
    nop
not_taken_target:
    beq   $0, $0, _co_test_end
    nop
