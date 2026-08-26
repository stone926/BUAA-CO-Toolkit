# Independent course ISA golden

`course-basic-v1.json` freezes one independently reviewed encode/decode word for
every required P3–P7 real instruction, plus the non-canonical runtime-recognition
counterexamples required by the phase-1 gate. The conformance runner never imports
the production ISA catalog; it invokes the compiled engine only through JSONL.

The sole review/integrity writer is `manage-isa-golden.mjs`:

```text
node expected/isaGolden/manage-isa-golden.mjs --verify
node expected/isaGolden/manage-isa-golden.mjs --verify --require-approved
node expected/isaGolden/manage-isa-golden.mjs --refresh-integrity
node expected/isaGolden/manage-isa-golden.mjs --approve --reviewer stone926 --review-revision 1
```

Refreshing a changed payload automatically removes an existing approval. The
only policy reviewer is the GitHub username `stone926`, and it must differ from
the artifact author. Production catalog generation and ordinary tests never
update this directory.

The reviewer string is audit metadata, not an identity signature. Its authority
comes from `.github/CODEOWNERS` and protected-branch code-owner review; see
`../../governance/README.md`. Candidate CLI checks remain useful for review but
cannot satisfy `verify:formal`.
