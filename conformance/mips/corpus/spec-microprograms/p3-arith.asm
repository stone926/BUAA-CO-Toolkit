# P3 arithmetic microprogram: add/sub/ori/lui/nop, 32-bit wrap-around, no overflow traps.
# Expected state (all GPRs reset to zero): see corpus/manifest.json COURSE-VEC-P3-ARITH-001.
.text
    add $t0, $0, $0          # 0x3000: $t0 = 0
    ori $t1, $0, 0x1234      # 0x3004: $t1 = 0x00001234
    lui $t2, 0x1234          # 0x3008: $t2 = 0x12340000
    add $t3, $t1, $t2        # 0x300c: $t3 = 0x12341234
    sub $t4, $t2, $t1        # 0x3010: $t4 = 0x1233edcc
    add $t5, $t2, $t2        # 0x3014: $t5 = 0x24680000 (wrap test, no trap)
    sub $t6, $0, $t1         # 0x3018: $t6 = 0xffffedcc
    nop                      # 0x301c
_end:
    beq $0, $0, _end         # 0x3020: standard halt loop
    nop                      # 0x3024
