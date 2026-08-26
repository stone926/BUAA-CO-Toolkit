# Phase-0 approval governance

Phase-0 expected data and performance baselines use one workflow:

1. automation creates or verifies a `candidate`;
2. `stone926` reviews the raw source, normalized expected data or benchmark
   samples, hashes, and diff;
3. a dedicated approval command records reviewer, date, and revision;
4. the formal gate accepts only the reviewed artifact and its exact hashes.

The reviewer string inside JSON is audit metadata, not a signature and not
proof of the caller's GitHub identity. Repository authority comes from all of
the following controls:

- `.github/CODEOWNERS` assigns the trust-root paths to `@stone926`;
- the protected default branch must require code-owner approval, dismiss stale
  approvals after new commits, and require the formal status check when phase 0
  is being closed;
- approved artifacts are merged only through that protected branch. Direct
  pushes to the protected paths must be disabled.

GitHub branch-protection settings are external repository state and cannot be
created by this source tree. A checkout can validate hashes and the allowed
reviewer claim, but it cannot authenticate who typed a local `--reviewer`
argument. Candidate verification is therefore useful before review but never
counts as the formal phase gate.
