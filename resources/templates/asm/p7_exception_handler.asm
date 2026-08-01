.ktext ${exceptionHandlerHex}
_co_excep:
    bne $k1, $0, _co_excep_skip
    nop
    ori $k1, $0, 1
    sb $0, ${intAckHex}($0)
    eret
_co_excep_skip:
    mfc0 $k0, $14
    addi $k0, $k0, 4
    mtc0 $k0, $14
    eret
