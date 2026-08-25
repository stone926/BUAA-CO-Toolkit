# P3 memory microprogram: sw/lw on DM bounds 0x0000 and 0x2ffc (word aligned).
# Expected state: see corpus/manifest.json COURSE-VEC-P3-MEMORY-001.
.text
    ori $t0, $0, 0x00ff      # 0x3000: $t0 = 0x000000ff
    sw $t0, 0x0000($0)       # 0x3004: DM[0x0000] = 0x000000ff (lower bound)
    sw $t0, 0x2ffc($0)       # 0x3008: DM[0x2ffc] = 0x000000ff (last word)
    lw $t1, 0x0000($0)       # 0x300c: $t1 = 0x000000ff
    lw $t2, 0x2ffc($0)       # 0x3010: $t2 = 0x000000ff
    ori $t3, $0, 0x5aa5      # 0x3014: $t3 = 0x00005aa5
    sw $t3, 0x1004($0)       # 0x3018: DM[0x1004] = 0x00005aa5
    lw $t4, 0x1004($0)       # 0x301c: $t4 = 0x00005aa5
    sub $t5, $t4, $t4        # 0x3020: $t5 = 0
_end:
    beq $0, $0, _end         # 0x3024: standard halt loop
    nop                      # 0x3028
