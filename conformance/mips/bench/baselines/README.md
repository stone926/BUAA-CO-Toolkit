# Approved performance baselines

Do not place invented or developer-estimated numbers here. A baseline consists of:

1. the unmodified candidate JSON emitted on `github-hosted:ubuntu-24.04` or
   `github-hosted:windows-2025`;
2. an approval envelope produced by `approve-baseline.mjs` after reviewing all
   raw samples, p50/p95, bootstrap interval, CPU, and RSS fields;
3. a matching ADR revision.

The candidate embeds its GitHub Actions repository, workflow ref, commit, job,
run/attempt URL, hosted-runner identity, image revision, and real runtime probes.
The reviewer must open that run URL and compare the downloaded artifact before
creating an envelope; these fields are audit provenance, not a cryptographic
attestation by themselves.

Eligible collection is restricted to a manual dispatch of the protected
`main` version of `.github/workflows/ci.yml`. The approval reviewer claim must
be `stone926`. The string alone does not authenticate its caller: CODEOWNERS and
protected-branch code-owner review provide that authority, as described in
`../../governance/README.md`.

The approval command uses create-only output and fingerprints the complete
candidate. Re-running a benchmark never overwrites an approved baseline.

The four required files are fixed so a partial or orphaned approval cannot pass:

- `mars-ubuntu-24.04-candidate.json` + `mars-ubuntu-24.04-approval.json`
- `mars-windows-2025-candidate.json` + `mars-windows-2025-approval.json`

After copying the two downloaded candidates to those names, create each approval
with `--reviewer stone926 --review-revision <n>`, then run
`npm run benchmark:verify-approved`. The gate recomputes both candidates and
requires both exact envelopes; it intentionally fails while any evidence is
missing.

No approved baseline is checked in yet. This is intentional: the repository
must obtain the external workflow artifacts before phase 0 can pass its final
performance-evidence gate.
