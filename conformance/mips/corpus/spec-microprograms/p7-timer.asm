.text
    ori   $t0, $0, 3
    sw    $t0, 0x7f04($0)
    ori   $t0, $0, 9
    sw    $t0, 0x7f00($0)
    ori   $t1, $0, 0x0401
    mtc0  $t1, $12
wait:
    beq   $0, $0, wait
    nop

.ktext 0x4180
handler:
    sw    $0, 0x7f00($0)
    mfc0  $k0, $13
    eret
    nop
