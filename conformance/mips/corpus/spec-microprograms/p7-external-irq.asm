.text
    ori   $t0, $0, 0x1001
    mtc0  $t0, $12
    ori   $t1, $0, 1
irq_target:
    addiu $t1, $t1, 1
    beq   $0, $0, irq_target
    nop

.ktext 0x4180
handler:
    sb    $0, 0x7f20($0)
    mfc0  $k0, $13
    eret
    nop
