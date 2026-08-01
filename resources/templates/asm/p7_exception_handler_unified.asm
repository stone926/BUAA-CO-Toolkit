.ktext ${exceptionHandlerHex}
_co_excep:
    mfc0 $k0, $13
    andi $k1, $k0, 0x7c
    bne $k1, $0, _co_excep_skip
    nop
    sb $0, ${intAckHex}($0)
    eret
_co_excep_skip:
    mfc0 $k0, $14
    addi $k0, $k0, 4
    mtc0 $k0, $14
    eret
