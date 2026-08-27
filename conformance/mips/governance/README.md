# Conformance reviews and archived governance artifacts

The phase-0 approval workflow (candidate → independent review → immutable
approval envelope → formal gate) was used exactly once, to close phases 0/1 on
2026-08-27. For a single-maintainer project it turned out to be ceremony: the
reviewer and the approver were the same person, so the envelope could never add
independence beyond what the review itself already provided.

What remains here:

- `phase0-expected-data-review-2026-08-27.md` — the review record for the only
  approval round (method, per-artifact findings, four recorded notes).
- `archived-approvals-2026-08-27/` — the 16 expected-data envelopes and the two
  benchmark envelopes created in that round, kept read-only for provenance.

Nothing in the conformance harness reads these files anymore. Refreshing
expected data or a benchmark candidate is an ordinary change reviewed in the
diff and backed by the CI checks; see the top-level README in `conformance/mips`.
