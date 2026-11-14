# Course exercise TypeScript translations

These 23 independent packages translate every exercise directory in
`cscore/加指令练习` (2022 and 2023). Each `instruction.ts` is a complete default
export that can be copied to a trusted workspace's `.co/custom-instructions`.
The type-only public SDK import is erased by the native TypeScript loader;
the resulting instruction has no runtime imports, Java, Node package, or compiler
dependency. The creation command installs the `@buaa-co/instructions` editor declarations
for copied files; the same public SDK is used by these fixtures.

`index.json` records the flattened source paths and current Markdown/class SHA-256 identities.
`originalMarkdownSha256` preserves the pre-flattening Markdown identity. The published
exercise repository is https://github.com/stone926/BUAA-CO-Add-Instruction-Exams.
Repeated names and incompatible encodings remain separate packages. In particular,
`addei` and `lhogez` share opcode 110011, while `bonall` and `lwer` share opcode
011001. They must not be loaded together. Each package declares all course modes
and ordinary MARS so the same definition can be tested across those runtimes;
the original exercise's course profile is recorded in the index.

`vectors.json` contains boundary inputs for the real Worker assembly/execution
gate. It covers signed extremes, zero operands, immediate 0/31/32/65535 where
defined, all byte lanes, conditional destinations, branch outcomes, and all four
`blztal` shift selectors. RLB stays within its documented immediate range 0..31.
The original addm class wraps Java integer addition before selecting the signed
maximum; the translation preserves that behavior, including boundary inputs.
The documented standard SB exercise checks aligned full-word trace projection.
LWER forces its memory address to a word boundary and selects an even register,
including register zero.

The source contains 21 `.class` references. SB uses native MARS, and LWER has no
class attachment. Set `CO_MARS_JAR` to the modded Mars jar and
`CO_CUSTOM_INSTRUCTION_FIXTURES` to the source exercise directory to run the
optional original-class image and canonical trace comparison in
`scriptExerciseIntegration.test.ts`. The normal gate always assembles and executes
all packages through native TypeScript workers.

Known historical discrepancies are explicit tests, not skipped comparisons:

* `P4_L2_BOMEZ_2022` warns that its class is wrong. Its class computes
  `popcount(rt) % popcount(rs)`. The 2023 BOMEZ attachment is byte-identical
  (SHA-256 `4cc38f179c862cccdf6010974da731af7a31a1a6a18408d3f9c15213ed02b8d1`).
  Both TypeScript bomez packages implement the documented
  `popcount(rs) % popcount(rt)`. Asymmetric positive/reverse vectors demonstrate
  this class error for each year's attachment.
* Both original BOMEZ class files and BONALL encode their two source registers
  in the reverse order from their Markdown diagrams. The TypeScript packages
  preserve the actual class encoding (`rt:5 rs:5`) and name callback fields by
  their logical assembly operands. The differential gate requires exact byte
  equality without rewriting either image.

Generator recipes are part of each definition. Conditional links and destinations
derive their effects from the execute callback. Explicit hazard timing is supplied
only for known reads and readiness; semantic coverage checks still have to prove
that changed source values influence the architectural result.
