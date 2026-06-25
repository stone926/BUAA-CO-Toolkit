.eqv COUNT 2

.macro store_word(%src, %dst)
    sw %src, 0(%dst)
.end_macro

.data
buf: .word
    COUNT
