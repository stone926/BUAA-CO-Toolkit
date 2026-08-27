# Hosted-runner MARS baseline candidates

Do not place invented or developer-estimated numbers here. A candidate baseline
consists of the unmodified JSON emitted on `github-hosted:ubuntu-24.04` or
`github-hosted:windows-2025` by the manually dispatched
`.github/workflows/ci.yml` (`run_fixed_benchmark=true`).

The candidate embeds its GitHub Actions repository, workflow ref, commit, job,
run/attempt URL, hosted-runner identity, image revision, and real runtime probes.
Before trusting one, open that run URL and compare the downloaded artifact;
these fields are audit provenance, not a cryptographic attestation.

Collection is restricted to a manual dispatch of the protected `main` version of
the workflow; `bench/validate-fixed-benchmark.mjs --require-eligible` recomputes
matrix/statistics/resources/hashes and rejects forged runner labels.

The current two candidates (`mars-ubuntu-24.04-candidate.json` and
`mars-windows-2025-candidate.json`, run 33074237426) were reviewed and used as
the phase-0 benchmark evidence. The immutable approval envelopes created for
them at that time are preserved under
`../governance/reviews/archived-approvals-2026-08-27/benchmark/` for
provenance; approvals are no longer a gate — refreshing a baseline is simply
re-dispatching the workflow and replacing the candidate files.
