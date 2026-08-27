# MIPS conformance gates

The harness exposes two deliberately different modes:

- `npm run verify:candidate` and `npm run run:candidate` validate candidate
  structure and execute it for review. Their JSON summary says
  `gate: "candidate"` and `required: false`.
- `npm run verify:formal` is the phase-0 formal gate. It requires approved ISA
  golden data, approved course vectors, the approved-data TS CLI run, both
  approved fixed-runner benchmark pairs, official Timer RTL evidence, pinned
  references, and the complete formal conformance lanes. It fails while any
  candidate or external evidence is missing.

`npm run run:required` is retained as an alias of the formal lane runner; it no
longer executes candidates. Compile the extension before running the formal
aggregate because TS CLI verification crosses the built JSONL process boundary.

`contract/evidence-gates.json` revision 2 expands 22 P3-P7 capability scopes
into 589 stable coverage-bin IDs. Every bin has a numeric minimum, and the
validator enforces kind-specific fingerprint fields (including forbidden
assembler/executor/device cross-contamination).

The 250 frozen PR seeds are executable evidence rather than seed-name metadata.
`verify:seed-evidence:candidate` (and its formal counterpart) deterministically
renders 250 unique ASM source graphs and HexText images, checks five combined
profile images with the pinned MARS assembler, then verifies all 5,000 words by
encode/decode through the compiled JSONL CLI. CI uploads the full source/image
evidence artifact. Run `npm run compile` before either aggregate verification.

Expected-data modules are in a stricter dependency closure. They may access the
filesystem only through `expected/guardedFs.mjs`, which rejects lexical and
real-path escapes from `conformance/mips`; the dependency check also rejects
direct/dynamic filesystem and child-process bypasses.

Approval commands never run from candidate CI. See
`governance/README.md` for reviewer identity and protected-branch requirements.
