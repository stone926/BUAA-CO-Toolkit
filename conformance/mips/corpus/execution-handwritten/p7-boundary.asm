# P7 handwritten comparable domain only: no exception, CP0, MMIO, interrupt or kernel path.
.text 0x00003000
    ori $1, $0, 0x71
    sw $1, 12284($0)
    lw $2, 12284($0)
    beq $1, $2, p7_taken
    ori $3, $0, 0x73
    ori $4, $0, 0x74
p7_taken:
    add $5, $1, $2
p7_halt:
    beq $0, $0, p7_halt
    nop
