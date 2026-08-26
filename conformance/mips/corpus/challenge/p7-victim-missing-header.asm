.text
victim:
    lw    $t0, 1($0)
_co_test_end:
    beq   $0, $0, _co_test_end
    nop
.ktext 0x4180
    mfc0  $k0, $13
    mfc0  $k1, $14
    addiu $k1, $k1, 4
    mtc0  $k1, $14
    eret
    nop
