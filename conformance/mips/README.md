# MIPS conformance checks

The harness is a plain test suite now: every check either passes or fails on its
own evidence; there is no separate "candidate vs approved" state to manage.

`npm run verify` aggregates: dependency whitelist, contract ledger, evidence
gates, corpus freeze, pinned references, frozen MARS regression, fixed seed
evidence, corpus/golden/vector verification, frozen decision vectors (the Timer
lane requires Icarus and only passes where `iverilog` is installed, e.g. CI),
the unit tests, TS CLI cross-checks, and the two runner lanes.

`contract/evidence-gates.json` revision 2 expands 22 P3-P7 capability scopes
into 589 stable coverage-bin IDs. Every bin has a numeric minimum, and the
validator enforces kind-specific fingerprint fields (including forbidden
assembler/executor/device cross-contamination).

The 250 frozen PR seeds are executable evidence rather than seed-name metadata.
`verify:seed-evidence` deterministically renders 250 unique ASM source graphs
and HexText images, checks five combined profile images with the pinned MARS
assembler, then verifies all 5,000 words by encode/decode through the compiled
JSONL CLI. CI uploads the full source/image evidence artifact. Run
`npm run compile` before the aggregate verification.

The course-vector lane now runs every P3-P6 program-final-state artifact through
the TS assembler and executor CLI, and replays the official Timer sequence
through `device.cycleVector`. The CP0-sequence and external-IRQ-sequence artifacts
remain explicitly labelled `directed-artifact-only` until a versioned production
CLI operation can consume those unit-level vectors; they are not reported as TS
execution evidence and use the separate `validated` result status rather than
incrementing the runner's `passed` count.

Expected-data modules are in a stricter dependency closure. They may access the
filesystem only through `expected/guardedFs.mjs`, which rejects lexical and
real-path escapes from `conformance/mips`; the dependency check also rejects
direct/dynamic filesystem and child-process bypasses.

## Refreshing expected data

1. Edit or regenerate the artifact with its `manage-*.mjs` command
   (`--refresh-integrity` recomputes derived hashes and force-downgrades any
   embedded approval claim back to `candidate`, which all artifacts stay as).
2. Review the diff manually; cross-check independent expected values against the
   course contract, the pinned MARS reference, and the TS engine CLI.
3. Commit through the normal path. There is no approval step: the artifact's
   own payload hash and the CI checks are the evidence.

The immutable approval envelopes written during the 2026-08-26 phase-0 gate
remain archived under `governance/reviews/archived-approvals-2026-08-27/` for
provenance; see `governance/reviews/phase0-expected-data-review-2026-08-27.md`
for how they were produced. They are no longer read by any check.
