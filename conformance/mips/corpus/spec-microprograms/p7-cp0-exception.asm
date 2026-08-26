.text
    lui   $t0, 0x7fff
    ori   $t0, $t0, 0xffff
victim:
    addi  $t1, $t0, 1
    ori   $t2, $0, 2
_co_test_end:
    beq   $0, $0, _co_test_end
    nop

.ktext 0x4180
handler:
    mfc0  $k0, $13
    mfc0  $k1, $14
    addi  $k1, $k1, 4
    mtc0  $k1, $14
    eret
    ori   $t3, $0, 0xdead
