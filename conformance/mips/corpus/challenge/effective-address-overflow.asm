.text
    lui  $t0, 0x7fff
    ori  $t0, $t0, 0xffff
    lw   $t1, 1($t0)
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
