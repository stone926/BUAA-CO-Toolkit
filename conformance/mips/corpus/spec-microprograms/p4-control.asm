.text
    ori  $t0, $0, 1
    jal  target
    ori  $t7, $0, 0xdead
target:
    ori  $t1, $31, 0
    beq  $t0, $t0, reached
    ori  $t2, $0, 0xdead
reached:
    ori  $t3, $0, 7
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
