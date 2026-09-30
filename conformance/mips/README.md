# MIPS conformance checks

The harness is a plain test suite now: every check either passes or fails on its
own evidence; there is no separate "candidate vs approved" state to manage.

The default checks use the builtin engine and committed independent evidence.
`npm run verify` checks the dependency whitelist, course contracts, evidence
gates, frozen corpus inputs, ISA/course vectors, decision vectors, unit tests,
and the versioned JSONL CLI. `npm run run` executes the course-vector lane
through that CLI. Neither command downloads nor starts MARS.
The local `verify:decisions` command reports the Timer RTL vector as unavailable
when `iverilog`/`vvp` are absent; CI uses `verify:decisions:rtl` after installing
Icarus and requires that evidence.

`contract/evidence-gates.json` revision 2 expands 22 P3-P7 capability scopes
into 589 stable coverage-bin IDs. Every bin has a numeric minimum, and the
validator enforces kind-specific fingerprint fields (including forbidden
assembler/executor/device cross-contamination).

Run `npm run compile` before checks that use the production JSONL CLI.
`verify:corpus-freeze` validates the 250 frozen seeds and rendered source/image
integrity without invoking a reference assembler.

Phase 6 has a separate execution corpus because the assembly seeds intentionally
include arbitrary jumps and exception-oriented cases that are unsafe for a
bounded differential run. `verify:execution-corpus` freezes 50 terminating
programs for each of P3-P7 plus one handwritten boundary program per profile.
`npm run verify:phase6` is the builtin-only switch gate: it checks the frozen
execution corpus, ISA and course vectors, JSONL CLI, and course-vector lane.
`verify:builtin-execution-corpus` assembles and executes all 255 frozen
execution cases through the JSONL boundary. It checks the corpus/source hashes,
the 250 generated independent image hashes, each case's course halt PC, and
the executor's bounded halted result. The five handwritten cases have frozen
source hashes but no separate expected image oracle. This gate records no MARS
comparison or legacy-oracle equivalence.
The former MARS-backed regression and phase-6 comparisons remain available as
explicit archival commands (`verify:references:archival`,
`verify:regression:archival`, `verify:seed-evidence:archival`,
`run:assembly-diff:archival`, `run:execution-diff:archival`,
`verify:phase6:archival`, `record:goldens:archival`, and `run:archival`). They continue to refer to the
historical `mars-assembler-v0.6.3` and `legacy-course-executor` artifacts; those
results are historical evidence and are not claims about stock MARS 4.5.

For a small stock-MARS assembler compatibility check, set `MARS_4_5_JAR` to an
official MARS 4.5 jar and run `npm run verify:official-mars-smoke` after
`npm run compile`. The script compares a standalone sample assembled by the
stock jar and builtin assembler using `CompactDataAtZero` plus explicit
`.text 0x00003000`; it does not download a jar and does not validate CO runtime,
trace, or P7 extensions.

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
