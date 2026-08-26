.text
    lui  $t0, 0x1122
    ori  $t0, $t0, 0x3344
    sw   $0, 0($0)
    swl  $t0, 1($0)
    swr  $t0, 2($0)
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
