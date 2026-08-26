.text
    # The verifier expands this fixture deterministically to 4095 and 4096
    # words; the marker keeps the checked-in repro small and reviewable.
    ori  $t0, $0, 0x6ffc
_co_test_end:
    beq  $0, $0, _co_test_end
    nop
