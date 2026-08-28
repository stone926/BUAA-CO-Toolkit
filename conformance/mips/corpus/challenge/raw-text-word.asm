# Intentional builtin-assembler extension (COURSE-COMMON-ASM-RAW-WORD-001).
# MARS rejects .word in .text; the builtin TS assembler accepts it as a raw
# 32-bit little-endian data word for future RI test-point injection.
.text
raw_word:
    .word 0x12345678
    ori $t0, $0, 1
    nop
