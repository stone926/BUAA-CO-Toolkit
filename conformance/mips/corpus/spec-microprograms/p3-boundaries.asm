.text
    lui  $t0, 0x8000
    add  $t1, $t0, $t0
    ori  $t2, $0, 0xffff
    add  $t3, $t0, $t2
    sub  $t4, $0, $t2
    sw   $t3, 0x2ffc($0)
    lw   $t5, 0x2ffc($0)
    beq  $t3, $t5, reached
    ori  $t6, $0, 0xdead
reached:
    ori  $t7, $0, 1
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
