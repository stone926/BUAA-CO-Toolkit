# Phase-0 decision vectors

These artifacts freeze four P7 decisions without importing the production TypeScript engine.

- `exception-priority`, `cp0-same-cycle`, and `unloaded-im-policy` are small directed policy oracles. They distinguish course-derived rules from product-domain decisions and enumerate only reachable/meaningful cells.
- `official-timer-rtl` compiles the exact course-distributed `P7_standard_timer_2019.v` snapshot (normalized-LF SHA-256 `047ac467...176f`) with `timer-restart.tb.v`. A JavaScript Timer model is not accepted as evidence for this decision.
- Local runs report Timer evidence as `unavailable` when `iverilog`/`vvp` are absent. CI invokes the runner with `--require-rtl`, where missing tools or any snapshot mismatch fail closed.

Run `node run-decision-vectors.mjs` locally or `node run-decision-vectors.mjs --require-rtl` in a proof-producing environment.
