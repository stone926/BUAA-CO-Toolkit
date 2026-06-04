# Course Testing Architecture

This document records the intended architecture for the BUAA CO testing loop:

```text
random generator -> ASM cases -> MARS machine code/golden trace -> CPU runner -> trace/log compare -> report
```

## Stage Responsibilities

### 1. Random Test Generator

The extension should not own the user's random generation strategy. It should provide:

- generator discovery and execution for common script types;
- configured runtime paths such as Python and Java;
- extra generator arguments for seeds, case counts, or output paths;
- before/after ASM snapshots so generated files can be detected without forcing a naming convention;
- report metadata recording generator path, command line, working directory, and generated ASM files.

Current implementation:

- `src/courseTesting/generator.ts`
- `CO: Run Generated Course Trace Tests`
- `co.toolchain.python`
- `co.test.generatorArgs`
- `co.test.generatedAsmLimit`

### 2. ASM Case Normalization

The extension should turn generated files into stable test cases:

- recognize `.asm`, `.s`, and `.mips`;
- auto-pair optional stdin files by filename convention;
- keep one case record per `(asm, stdin)` pair;
- avoid treating machine code `.txt` files as stdin.

Current implementation:

- `src/courseTest.ts` case expansion and stdin discovery.

### 3. MARS Golden Model

The extension should make MARS execution match course requirements:

- use `CompactDataAtZero`;
- enable delay slot according to the project profile;
- dump text segment to the configured machine-code filename;
- run the same ASM as golden trace;
- capture stdout and write deterministic output files under `.co/out`.

Current implementation:

- `src/mips.ts`
- `runMarsFile(..., 'dumpText')`
- `runMarsFile(..., 'run')`

### 4. CPU Import And Simulation

The runner is profile/backend-specific:

- P3 Logisim CPU: generate `v2.0 raw` ROM files from MARS machine code, create a `.circ` copy with the selected 32-bit ROM contents replaced, or batch-prepare generated ASM cases under `.co/logisim`. Logisim logging can be converted to CSV, but fully automatic circuit execution is not yet implemented.
- P4/P5 Verilog CPU: copy the generated machine code into `.co/isim`, generate ISE `.prj/.tcl`, run `fuse` and ISim, and capture simulator stdout.
- P6/P7 Verilog CPU: should use profile-specific testbench/interface checks before simulation.

Current implementation:

- P3 import helper: `src/logisim.ts`
- P3 ROM injection pure logic: `src/language/logisim/rom.ts`
- P3 batch preparation report helpers: `src/courseTesting/logisimPrep.ts`
- P4/P5/P6/P7 ISim runner foundation: `src/verilog.ts`
- full trace flow: `src/courseTest.ts`

### 5. Compare And Report

The extension should report failures in a way that maps directly to CPU debugging:

- parse MARS and simulator write traces;
- ignore cycle/time by default, with a strict mode available;
- locate the first semantic difference;
- include raw events, normalized PC/target/value, and source line numbers;
- write JSON reports that can be reopened.

Current implementation:

- `src/language/mips/traceParser.ts`
- `src/language/verilog/traceParser.ts`
- `src/language/mips/traceCompare.ts`
- `src/traceCompare.ts`
- `.co/out/trace-batch-report.json`

### 6. Continuous Execution And Monitoring

For P4+ Verilog trace tests, the extension should support a long-running test loop:

- choose a generator once;
- repeat generator execution, ASM discovery, MARS dump, MARS golden run, ISim run, and trace compare;
- stream progress to the BUAA CO output channel;
- keep a Webview monitor open during the run;
- write a durable JSON report after each case so progress is visible even if VSCode is closed;
- allow the user to request a stop without killing a currently running external tool process.

Current implementation:

- `CO: Start Continuous Generated Course Trace Tests`
- `CO: Stop Continuous Course Tests`
- `.co/out/continuous-trace-report.json`
- `src/courseTesting/continuous.ts`

The P3 Logisim flow currently supports batch preparation of injected circuit copies, but not reliable headless Logisim execution and logging. That remains a separate extension point because Logisim GUI simulation and logging are less stable to automate than MARS/ISim CLI runs.

## Module Boundary Rules

- Pure parsing, comparison, and generator file-discovery logic lives under `src/language/*` or `src/courseTesting/*` and must be unit-tested without VSCode UI.
- VSCode commands stay in thin orchestration modules such as `src/courseTest.ts`, `src/mips.ts`, `src/verilog.ts`, and `src/logisim.ts`.
- External tool calls go through `runTool` so timeout, stdout capture, cwd, and command display stay consistent.
- Reports should be JSON first, Webview second. The JSON is the durable artifact.
- Profile-specific behavior should be explicit in config or small strategy functions, not hidden in ad hoc filename checks.

## Next Extension Points

- P3 Logisim automatic runner if a reliable command-line or scripted logging path is available.
- P6/P7 testbench strategy selection and preflight checks before ISim.
- Hazard coverage analysis integration for generated P5/P6 machine-code cases.
- Generator templates for common P4/P5/P6 instruction coverage patterns.
