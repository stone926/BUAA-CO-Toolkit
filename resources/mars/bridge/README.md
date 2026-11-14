# Configurable MARS bridge

`mars-bridge.jar` is an extension-owned, Java 8 compatible reflection adapter.
It contains no MARS classes. It bundles the pinned ASM core bytecode reader;
its BSD license is included at `META-INF/LICENSE-ASM.txt` inside the jar and
`vendor/DEPENDENCIES.json` records provenance and SHA-256. End users need Java and their configured MARS jar;
they do not need `javac`. Rebuild with `node scripts/build-mars-bridge.mjs`
(maintainer JDK 17 or newer is required for reproducible archive timestamps).
The build also refreshes `artifact-manifest.json`, binding normalized Java,
build-script, and pinned dependency inputs to the shipped jar. Run
`node scripts/check-mars-bridge.mjs` to detect stale inputs or artifact bytes
using Node alone; normal compilation/CI checks do not need a JDK.

Run `co.mars.bridge.Main` with the bridge, configured jar, and each custom
instruction class directory on the Java classpath. The latter compensates for
the BUAA loader's historical file-URL classloading behavior without modifying
the jar or instruction classes.

Options are pairs: `--mode assemble|execute|console`, `--source PATH`,
`--layout Default|CompactLargeText|CompactDataAtZero|CompactTextAtZero`,
`--profile ordinary|P3|P4|P5|P6|P7`, `--delayed true|false`,
`--max-steps N`, `--result PATH`, optional `--halt-pc UINT32`, repeatable
`--class ABSOLUTE_PATH`, optional `--interrupt UINT32,UINT32`, and
`--expected-image PATH` containing `{ "segments": [...] }`.

The result file is UTF-8 JSON with `protocolVersion: 1`, `ok`, `javaVersion`,
`segments`, `customInstructions`, `symbols`, and `sourceMap`. Errors include a
`diagnostic`. Execution adds `instructions`, `exitCode`, and `stopReason`
(`halt-loop`, `exited`, `step-limit`, or `error`). Process exit zero alone does
not establish success: callers must require a valid result file and `ok: true`.
`classSupport` distinguishes `available` and `unavailable`; `classStatus`
distinguishes `none` and `loaded`. A requested class that fails loading is an
error, even if MARS itself reports a successful process exit.

Segments contain `{name,baseAddress,words}`, preserving disjoint text/ktext
ranges. The first run uses `text`/`ktext`; subsequent runs use the unique name
`text@<8hexbase>`/`ktext@<8hexbase>`. Data/kdata each use a single dense interval,
including explicit zero reservations. Data reservations are projected
from MARS-validated tokens using MARS' own macro substitution, tokenizer,
directive sizes, and numeric decoder; their final cursors must agree with the
assembler. Data words come from MARS memory, including partial-word bytes.
Source entries are `{address,path,line}` with one-based original source lines;
macro expansions may refer to their template line. Symbols are
`{name,value,kind,segment}`. Instruction metadata is read from the registered
instruction objects: `{mnemonic,mask,value,template,controlTransfer,unresolvedDynamicCalls}`. All addresses and words
are unsigned JSON numbers.

Course execution requires `CompactLargeText`, starts at PC `0x3000`, resets
GPRs and CP0 to zero, and rejects nonzero initial data memory before execution.
P3/P4 disable delayed branches; P5–P7 enable them. P7 requires the modded
course-exception API, uses vector `0x4180`, and preserves MARS' IRQ/timer state
by performing one continuous bounded simulation. Unsupported features fail
explicitly. Course execution requires a validated unconditional self branch
(`beq $0,$0,-1` or `j self`) followed by `nop` at `--halt-pc`. Success requires
that branch to execute and, when delayed branches are enabled, its nop slot
to complete. Falling off text is an error. Expected-image validation compares
every physical instruction address and named data word before registers reset
or execution begins. It accepts omitted zero instruction holes inside matching
instruction bounds. Course execution installs zero nop statements throughout
instruction holes from reset PC through the highest loaded word, matching the
DUT image; these synthetic statements do not create overlapping exported
segments. Ordinary console mode retains native MARS sparse-memory behavior.

Custom classes take precedence in both mnemonic matching and binary decoding.
Before execution, statements are reconstructed from the authoritative words,
so identical words select identical semantics even when source mnemonics differ.
Overlapping encodings between requested custom classes are rejected.

ASM follows the reachable `simulate` call graph through private, inherited,
and companion helpers, bounded to 128 classes, 2048 reachable methods, and
16 MiB of class bytes. Calls that schedule branches or change the PC establish
control-transfer intent; unused helper methods and link-only helpers do not.
For P7, a SimulationCode proxy marks that intent after IRQ preemption and before
the actual class executes, including untaken I-format branches. Annulled slots
clear the marker. Observed unresolved dynamic control changes fail explicitly.
No user jar or class file is changed.

Course execution rejects actual HI/LO reads before an instruction defines the
register, native division by zero/signed overflow, and control transfers in
delay slots. P5/P6 ordinary arithmetic overflow wraps; P7 raises its architectural
exception. Timer accesses remain enabled: optional `timerUsed`,
`timerActivated`, and `timerTimingObserved` result fields describe actual
peripheral use, activation, and timing-dependent reads/Timer IRQ observation.
These fields report MARS behavior and let callers qualify reference timing
evidence; they do not disable existing DUT Timer probes.

Course stdout consists of normalized GPR/DM writes, including repeated writes
of the same value. Ordinary console stdout and stdin remain available to MARS
syscalls. Native MARS logging is disabled through nonpersistent settings.
