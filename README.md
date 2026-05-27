# BUAA CO Toolkit

VSCode extension for BUAA Computer Organization labs. The first implementation focuses on Logisim, MARS/MIPS ASM, and Verilog workflows.

## Features

- MIPS ASM language support: highlighting, completion, hover, labels, definitions, diagnostics, formatting, MARS run, `.text` dump, and kernel text dump.
- Verilog language support: highlighting, module/signal outline, hover, definitions, implicit-net diagnostics, BUAA CO top-module checks, testbench generation, ISE `.prj/.tcl` generation, and ISim run command.
- Logisim support: `.circ` recognition, circuit/component outline, label diagnostics, MARS `code.txt` to Logisim ROM conversion, logging text to CSV conversion, and opening circuits with `logisim.jar`.

## Required Configuration

Set these in VSCode settings as needed:

```json
{
  "co.toolchain.mars": "E:/path/to/Mars4_5.jar",
  "co.toolchain.logisim": "E:/path/to/logisim.jar",
  "co.toolchain.isePath": "D:/Xilinx/14.7/ISE_DS/ISE",
  "co.project.profile": "P5"
}
```

Run `CO: Check Toolchain` to verify Java, MARS, Logisim, and ISE paths.
