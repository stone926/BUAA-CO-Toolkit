.ktext 0x4180
_co_excep:
    mfc0 $k0, $13
    andi $k1, $k0, 0x7c
    bne $k1, $0, _co_excep_skip
    nop
    ori $k0, $0, ${intAckHex}
    sb $0, 0($k0)
    eret
_co_excep_skip:
    mfc0 $k0, $14
    addi $k0, $k0, 4
    mtc0 $k0, $14
    eret
