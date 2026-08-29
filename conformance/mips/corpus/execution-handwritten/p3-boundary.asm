# P3 handwritten: taken control flow, DM upper boundary and no delay-slot execution.
.text 0x00003000
    ori $1, $0, 0x31
    sw $1, 12284($0)
    lw $2, 12284($0)
    beq $1, $2, p3_taken
    ori $3, $0, 0x33
    ori $4, $0, 0x44
p3_taken:
    add $5, $1, $2
p3_halt:
    beq $0, $0, p3_halt
    nop
