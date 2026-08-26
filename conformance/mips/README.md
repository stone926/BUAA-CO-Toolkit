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

Approval commands never run from candidate CI. See
`governance/README.md` for reviewer identity and protected-branch requirements.
