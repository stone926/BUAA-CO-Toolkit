# P3 branch microprogram: beq not-taken / taken paths, skipped instruction stays skipped.
# Expected state: see corpus/manifest.json COURSE-VEC-P3-BRANCH-001.
.text
    ori $t0, $0, 3           # 0x3000: $t0 = 3
    beq $t0, $0, _never      # 0x3004: not taken ($t0 = 3)
    ori $t1, $0, 1           # 0x3008: $t1 = 1
    sub $t0, $t0, $t1        # 0x300c: $t0 = 2
    sub $t0, $t0, $t1        # 0x3010: $t0 = 1
    sub $t0, $t0, $t1        # 0x3014: $t0 = 0
    beq $t0, $0, _taken      # 0x3018: taken
    ori $t2, $0, 99          # 0x301c: must NOT execute
_never:
_taken:
    ori $t3, $0, 7           # 0x3020: $t3 = 7
    lui $t4, 0x0001          # 0x3024: $t4 = 0x00010000
_end:
    beq $0, $0, _end         # 0x3028: standard halt loop
    nop                      # 0x302c
