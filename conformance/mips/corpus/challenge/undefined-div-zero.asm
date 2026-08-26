.text
    ori  $t0, $0, 7
    div  $t0, $0
    mflo $t1
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
