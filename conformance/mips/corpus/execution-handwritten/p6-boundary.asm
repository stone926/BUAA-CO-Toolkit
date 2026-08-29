# P6 handwritten: delayed branch plus byte/half-word lanes at the DM upper boundary.
.text 0x00003000
    ori $1, $0, 0x61
    sb $1, 12287($0)
    lb $2, 12287($0)
    ori $6, $0, 0x6263
    sh $6, 12284($0)
    lh $7, 12284($0)
    beq $1, $2, p6_taken
    ori $3, $0, 0x63
    ori $4, $0, 0x64
p6_taken:
    mult $1, $2
    mflo $5
p6_halt:
    beq $0, $0, p6_halt
    nop
