# BUAA CO Toolkit

VSCode extension for BUAA Computer Organization labs. The first implementation focuses on Logisim, MARS/MIPS ASM, and Verilog workflows.

## Features

- MIPS ASM language support: highlighting, completion, hover, labels, definitions, diagnostics, formatting, MARS run, MARS run with a stdin file, interactive terminal MARS run, `.text` dump, and kernel text dump.
- Verilog language support: highlighting, module/signal outline, hover, definitions, implicit-net diagnostics, BUAA CO top-module checks, testbench generation, ISE `.prj/.tcl` generation, and ISim run command.
- Logisim support: `.circ` file-pattern recognition, circuit/component outline, label diagnostics, MARS `code.txt` to Logisim ROM conversion, machine-code injection into a `.circ` ROM copy, logging text to CSV conversion, and opening circuits with `logisim.jar`. XML editing support is intentionally left to the user's VSCode/XML extensions.
- Course testing helpers: run a random ASM generator, detect generated ASM files, dump generated machine code, continuously rerun generated trace tests with a live monitor for P4-P6, prepare P3 Logisim `.circ` copies with injected machine code, run MARS dump + MARS golden output + ISim simulation + trace compare for P4-P6, batch multiple ASM cases with auto-paired stdin files and a JSON summary report, or compare MARS/ISim trace outputs manually from `.co/out/*.mars.out` and `.co/out/*.sim.out`. P7 intentionally exposes only ASM test generation and machine-code dump, not automatic trace testing or compare.

## Course Test Flow

The intended P4-P6 CPU trace test loop is:

1. Write or select a random ASM generator.
2. Run `CO: Run Generated Course Trace Tests`; `.py`, `.js`, `.jar`, `.bat/.cmd/.exe`, and `.ps1` generators are recognized.
3. The extension snapshots ASM files, runs the generator, then picks up new or modified `.asm`, `.s`, and `.mips` files.
4. For each case, MARS dumps machine code, MARS produces the golden trace, and Verilog ISim imports the machine code for automatic trace comparison.
5. For P3 Logisim CPUs, use `CO: Prepare Generated Logisim Circuit Cases` to run the generator, MARS-dump each generated ASM, and write injected `.circ` copies plus `.co/logisim/logisim-prep-report.json`. For one-off imports, use `CO: MIPS Dump Text Segment` followed by `CO: Logisim Generate ROM File`, or `CO: Logisim Inject ROM Into Circuit`.

Use `CO: Start Continuous Generated Course Trace Tests` when you want the generator + MARS + ISim + trace compare loop to keep running. It opens a live monitor, streams progress to the BUAA CO output channel, writes `.co/out/continuous-trace-report.json` after each case, and can be stopped with `CO: Stop Continuous Course Tests`. By default the session stops after the first failed or errored iteration; set `co.test.continuousStopOnFailure` to `false` to keep running.

P7 uses `CO: Generate ASM Tests` and `CO: Generate and Dump Machine Code Tests` instead of automatic trace testing. Its built-in generator uses `co.test.builtinGenerator.p7InstructionCount` (default 1118) as the generated main-program instruction count, because the course CPU fixes the exception entry at `0x4180`. P7 dump is restricted to `CompactLargeText`; large-text memory modes change that layout or let execution fall into the handler area. P7 Verilog testbench generation uses the official tutorial testbench structure.

Trace tests expect the modified MARS build that supports `coL1` trace output, such as `Toby-Shi-cloud/Mars-with-BUAA-CO-extension`. With `co.mips.memoryConfiguration: "auto"`, P3-P6 trace tests use `FixedCompactLargeText` to allow long generated machine-code files.

For ASM programs that read stdin, use `CO: MIPS Run with Stdin File` for deterministic runs or `CO: MIPS Run in Terminal` for manual interactive input. Full and batch trace tests auto-pair stdin files named like `foo.in`, `foo.input`, `foo.stdin`, `foo.dat`, `foo.case.in`, `foo-case.in`, or `foo_case.in` next to `foo.asm`, including the `input`, `inputs`, `test`, `tests`, and `data` subdirectories.

Batch trace reports are written to `.co/out/trace-batch-report.json` and include the generator command, generated ASM files, and first differing MARS/SIM event for each failed case.

## Required Configuration

Set these in VSCode settings as needed:

```json
{
  "co.toolchain.mars": "E:/path/to/Mars4_5.jar",
  "co.toolchain.logisim": "E:/path/to/logisim.jar",
  "co.toolchain.isePath": "D:/Xilinx/14.7/ISE_DS/ISE",
  "co.toolchain.python": "python",
  "co.project.profile": "P5",
  "co.mips.memoryConfiguration": "auto",
  "co.project.simTime": "200us"
}
```

`co.project.simTime` is written into the generated ISim TCL as `run <value>; exit`; the default `200us` matches the course-style scripts. Use `co.test.generatorArgs` when your generator needs extra arguments such as a seed or output count. `co.test.continuousIntervalMs`, `co.test.continuousMaxIterations`, and `co.test.continuousStopOnFailure` control continuous generated trace tests. Run `CO: Check Toolchain` to verify Java, Python, MARS, Logisim, and ISE paths.
