.text
    lui  $t0, 0x80ff
    ori  $t0, $t0, 0x7f01
    sw   $t0, 0($0)
    lb   $t1, 0($0)
    lb   $t2, 1($0)
    lb   $t3, 2($0)
    lh   $t4, 2($0)
    ori  $t5, $0, 0x00aa
    sb   $t5, 1($0)
    ori  $t6, $0, 0x1234
    sh   $t6, 2($0)
    lw   $t7, 0($0)
    ori  $s0, $0, 6
    addi $s1, $0, -3
    mult $s0, $s1
    mfhi $s2
    mflo $s3
    div  $s1, $s0
    mfhi $s4
    mflo $s5
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
