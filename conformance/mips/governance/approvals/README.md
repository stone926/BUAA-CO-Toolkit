# Approved phase-0 artifacts

This tree contains append-only approval envelopes. Candidate payloads stay in
their domain directories (`corpus/`, `expected/`, `contract-difference-rules/`
or `waivers/`); an approval file binds one exact canonical JSON SHA-256.

The path is `<kind>/<artifact-id>/<candidate-sha256>.approval.json`. Commands
must create a new path and never replace an existing envelope. A changed
candidate therefore becomes unapproved automatically while its old review
record remains auditable.

No envelope is checked in yet. Phase 0 must remain formally closed until the
candidate diffs have been reviewed by `stone926` and merged through protected
GitHub review. The reviewer field is audit metadata, not authentication by
itself.
