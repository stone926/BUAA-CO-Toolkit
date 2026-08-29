# P5 handwritten: the taken branch commits its slot, skips the successor and preserves DM boundary data.
.text 0x00003000
    ori $1, $0, 0x51
    sw $1, 12284($0)
    lw $2, 12284($0)
    beq $1, $2, p5_taken
    ori $3, $0, 0x53
    ori $4, $0, 0x54
p5_taken:
    add $5, $1, $2
p5_halt:
    beq $0, $0, p5_halt
    nop
