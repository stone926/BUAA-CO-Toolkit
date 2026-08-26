.data 0x00008000
outside_course_dm:
    .word 0x12345678
.text
    ori  $t0, $0, 0x8000
    lw   $t1, 0($t0)
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
