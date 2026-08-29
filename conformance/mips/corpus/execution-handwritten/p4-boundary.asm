# P4 handwritten: taken control flow, DM upper boundary and no delay-slot execution.
.text 0x00003000
    ori $1, $0, 0x41
    sw $1, 12284($0)
    lw $2, 12284($0)
    beq $1, $2, p4_taken
    ori $3, $0, 0x43
    ori $4, $0, 0x44
p4_taken:
    sub $5, $2, $1
p4_halt:
    beq $0, $0, p4_halt
    nop
