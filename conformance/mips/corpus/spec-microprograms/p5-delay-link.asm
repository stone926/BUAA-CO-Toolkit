.text
    ori  $t0, $0, 1
    jal  target
    ori  $t1, $0, 2
    ori  $t7, $0, 0xdead
target:
    addu $t2, $31, $0
    beq  $t0, $t0, reached
    ori  $t3, $0, 3
    ori  $t4, $0, 0xdead
reached:
    ori  $t5, $0, 5
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
