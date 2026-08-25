# Minimal repro of MARS-DIV-GPSP-001: stable MARS seeds $gp/$sp from the Compact*
# memory map while the course CPU resets all GPRs to zero. The first store
# observable differs: MARS writes 0x00001800, the course CPU writes 0x00000000.
# This case is legacy-baseline-only; it must never become a strict course vector.
.text
    sw $gp, 0x0000($0)       # 0x3000: DM[0] = $gp initial value (diverges)
    sw $sp, 0x0004($0)       # 0x3004: DM[4] = $sp initial value (diverges)
_end:
    beq $0, $0, _end         # 0x3008: standard halt loop
    nop                      # 0x300c
