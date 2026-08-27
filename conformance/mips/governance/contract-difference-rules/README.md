# Contract difference rules

Each active rule is one `COURSE-*.json` candidate validated by
`../validate-governed-exceptions.mjs`. Predicates use a small declarative AST;
arbitrary scripts, regexes, wildcard scopes, and catch-all predicates are not
accepted. An active formal run additionally requires the exact candidate's
append-only approval envelope.

The divergence ledger is documentation and does not activate a rule. No rule
is active yet; known MARS differences remain explicit candidate work until a
narrow predicate, directed tests, critical mutants, and human approval exist.
