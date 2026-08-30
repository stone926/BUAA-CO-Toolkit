import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const courseWatchdogLimitPs = 200_000;
const courseInstructionWords = 4096;

/**
 * Compile and execute the production-generated course testbench shapes with
 * the packaged Icarus runtime. The DUTs are deliberately tiny protocol
 * exercisers: this gate validates ports, generated memory/TB glue, Trace
 * formats, and P7 interrupt/probe wiring without vendoring full student CPUs.
 */
export function verifyBundledIverilogCourseCompatibility({
  extensionRoot,
  workingDirectory,
  iverilog,
  vvp,
  runCommand,
}) {
  const extensionRequire = createRequire(join(extensionRoot, "package.json"));
  const moduleUtilsPath = join(
    extensionRoot,
    "out",
    "language",
    "verilog",
    "moduleUtils.js",
  );
  const traceParserPath = join(
    extensionRoot,
    "out",
    "language",
    "verilog",
    "traceParser.js",
  );
  const iverilogRuntimePath = join(
    extensionRoot,
    "out",
    "verilog",
    "iverilogRuntime.js",
  );
  const courseConfigPath = join(extensionRoot, "resources", "co", "courseConfig.json");
  const { buildTestbench } = extensionRequire(moduleUtilsPath);
  const { parseSimOutput } = extensionRequire(traceParserPath);
  const { buildIverilogIncludeArgs } = extensionRequire(iverilogRuntimePath);
  const courseConfig = JSON.parse(readFileSync(courseConfigPath, "utf8"));

  if (
    typeof buildTestbench !== "function"
      || typeof parseSimOutput !== "function"
      || typeof buildIverilogIncludeArgs !== "function"
  ) {
    throw new Error("Packaged Verilog testbench, Trace parser, or Icarus include helper is unavailable.");
  }
  cachedBuildTestbench = buildTestbench;
  const includeArgsFor = (sourceFiles) => buildIverilogIncludeArgs(workingDirectory, sourceFiles);

  const p1Ports = [
    { name: "clk", direction: "input", width: 1 },
    { name: "reset", direction: "input", width: 1 },
    { name: "result", direction: "output", width: 8 },
  ];
  const p4Ports = requireProfilePorts(courseConfig, "P4");
  const p5Ports = requireProfilePorts(courseConfig, "P5");
  const p6Ports = requireProfilePorts(courseConfig, "P6");
  const p7Ports = requireProfilePorts(courseConfig, "P7");

  runCourseCase({
    label: "P1",
    profile: "P1",
    topModuleName: "main",
    testbenchName: "main_tb",
    module: verilogModule("main", p1Ports),
    testbenchOptions: { profile: "P1", finishDelay: false },
    dutText: p1Dut(p1Ports),
    dutDirectoryName: join("course source tree 中文", "nested include path"),
    supportFiles: [
      {
        relativePath: "defs.vh",
        text: "`define CO_P1_VALUE 8'h2a\n",
      },
      {
        relativePath: "workspace root defs.vh",
        text: "`define CO_P1_ROOT_MASK 8'h00\n",
        location: "workspace",
      },
    ],
    expectedTestbenchText: [
      "module main_tb;",
      ".clk(clk)",
      ".reset(reset)",
      ".result(result)",
      "forever #5 clk = ~clk;",
    ],
    verifyOutput(stdout) {
      assertIncludes(stdout, "CO_COURSE_P1 result=2a", "P1 functional output");
    },
    workingDirectory,
    iverilog,
    vvp,
    runCommand,
    includeArgsFor,
  });

  runCourseCase({
    label: "P4",
    profile: "P4",
    topModuleName: "mips",
    testbenchName: "mips_tb",
    module: verilogModule("mips", p4Ports),
    testbenchOptions: { profile: "P4", finishDelay: false },
    dutText: p4Dut(p4Ports),
    expectedTestbenchText: ["module mips_tb;", ".clk(clk)", ".reset(reset)"],
    verifyOutput(stdout) {
      assertTraceEvent(parseSimOutput, stdout, {
        pc: "00003000",
        kind: "grf",
        target: "1",
        value: "12345678",
      }, "P4 single-cycle Trace");
    },
    workingDirectory,
    iverilog,
    vvp,
    runCommand,
    includeArgsFor,
  });

  runCourseCase({
    label: "P5",
    profile: "P5",
    topModuleName: "mips",
    testbenchName: "mips_tb",
    module: verilogModule("mips", p5Ports),
    testbenchOptions: { profile: "P5", finishDelay: false },
    dutText: p5Dut(p5Ports),
    expectedTestbenchText: ["module mips_tb;", "forever #5 clk = ~clk;"],
    verifyOutput(stdout) {
      assertTraceEvent(parseSimOutput, stdout, {
        pc: "00003008",
        kind: "grf",
        target: "2",
        value: "89abcdef",
        requireCycle: true,
      }, "P5 pipelined Trace");
    },
    workingDirectory,
    iverilog,
    vvp,
    runCommand,
    includeArgsFor,
  });

  runCourseCase({
    label: "P6",
    profile: "P6",
    topModuleName: "mips",
    testbenchName: "mips_tb",
    module: verilogModule("mips", p6Ports),
    testbenchOptions: { profile: "P6", finishDelay: false },
    dutText: p6Dut(p6Ports),
    machineCode: courseMachineCode("3401002a"),
    expectedTestbenchText: [
      '$readmemh("code.txt", inst);',
      "assign i_inst_rdata = inst[(i_inst_addr - 32'h3000) >> 2];",
      '$display("%d@%h: *%h <= %h"',
      '$display("%d@%h: $%d <= %h"',
    ],
    verifyOutput(stdout) {
      assertTraceEvent(parseSimOutput, stdout, {
        pc: "00003000",
        kind: "grf",
        target: "1",
        value: "3401002a",
        requireCycle: true,
      }, "P6 external-IM register Trace");
      assertTraceEvent(parseSimOutput, stdout, {
        pc: "00003004",
        kind: "dm",
        target: "00000004",
        value: "cafebabe",
        requireCycle: true,
      }, "P6 byte-enable data-memory Trace");
    },
    workingDirectory,
    iverilog,
    vvp,
    runCommand,
    includeArgsFor,
  });

  const p7Module = verilogModule("mips", p7Ports);
  const p7MachineCode = courseMachineCode("3401002a");
  const p7DutText = p7Dut(p7Ports);

  runCourseCase({
    label: "P7-anchor",
    profile: "P7",
    topModuleName: "mips",
    testbenchName: "mips_tb",
    module: p7Module,
    testbenchOptions: { profile: "P7", interruptSchedule: [0x3010] },
    dutText: p7DutText,
    machineCode: p7MachineCode,
    expectedTestbenchText: [
      "module mips_tb;",
      "parameter target_pc = 32'h00003010;",
      "always @(negedge clk) begin",
      "(m_int_addr & 32'hfffffffc) == 32'h7f20",
      '$display("%d@%h: $%d <= %h"',
    ],
    verifyOutput(stdout) {
      assertIncludes(stdout, "CO_COURSE_P7_INTERRUPT", "P7 scheduled interrupt delivery");
      assertTraceEvent(parseSimOutput, stdout, {
        pc: "00003010",
        kind: "grf",
        target: "3",
        value: "13579bdf",
        requireCycle: true,
      }, "P7 anchor Trace");
    },
    workingDirectory,
    iverilog,
    vvp,
    runCommand,
    includeArgsFor,
  });

  runCourseCase({
    label: "P7-probe",
    profile: "P7",
    topModuleName: "mips",
    testbenchName: "mips_tb",
    module: p7Module,
    testbenchOptions: {
      profile: "P7",
      p7Probe: {
        scenarios: [{
          id: 7,
          kind: "external",
          waitPc: 0x3010,
          armAddress: 0x27d0,
          armValue: 7,
          externalDelayCycles: 1,
        }],
      },
    },
    dutText: p7DutText,
    machineCode: p7MachineCode,
    expectedTestbenchText: [
      "CO_P7_PROBE external_arm",
      "CO_P7_PROBE external_raise",
      "CO_P7_PROBE external_ack",
      "co_p7_external_legacy = 0;",
      "co_p7_external_wait_count >= co_p7_external_delay",
      "co_p7_external_delay = 1;",
      "co_p7_external_arm_addr = 32'h000027d0;",
      "co_p7_external_arm_value = 32'h00000007;",
      "co_p7_external_target = 32'h00003010;",
    ],
    verifyOutput(stdout) {
      assertOrdered(stdout, [
        "CO_P7_PROBE external_arm scenario=7",
        "CO_P7_PROBE external_raise scenario=7",
        "CO_P7_PROBE external_ack scenario=7",
      ], "P7 armed/delayed external interrupt lifecycle");
      assertNotIncludes(stdout, "external_raise_unarmed", "P7 armed interrupt lifecycle");
    },
    workingDirectory,
    iverilog,
    vvp,
    runCommand,
    includeArgsFor,
  });

  return ["P1", "P4", "P5", "P6", "P7-anchor", "P7-probe"];
}

function runCourseCase({
  label,
  topModuleName,
  testbenchName,
  module,
  testbenchOptions,
  dutText,
  dutDirectoryName,
  supportFiles = [],
  machineCode,
  expectedTestbenchText,
  verifyOutput,
  workingDirectory,
  iverilog,
  vvp,
  runCommand,
  includeArgsFor,
}) {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const dutDirectory = dutDirectoryName
    ? join(workingDirectory, dutDirectoryName)
    : workingDirectory;
  mkdirSync(dutDirectory, { recursive: true });
  const dutPath = join(dutDirectory, `${safeLabel} course dut.v`);
  const testbenchPath = join(workingDirectory, `${safeLabel} generated course tb.v`);
  const watchdogPath = join(workingDirectory, `${safeLabel} course watchdog.v`);
  const outputPath = join(workingDirectory, `${safeLabel} course simulation.vvp`);
  const watchdogModule = `__co_course_watchdog_${safeLabel.replace(/-/g, "_")}`;
  const testbenchText = loadTestbenchBuilder(module, testbenchName, testbenchOptions);

  for (const expected of expectedTestbenchText) {
    assertIncludes(testbenchText, expected, `${label} generated testbench contract`);
  }
  if (testbenchText.includes("${")) {
    throw new Error(`${label} generated testbench contains an unresolved template placeholder.`);
  }

  for (const supportFile of supportFiles) {
    const supportRoot = supportFile.location === "workspace"
      ? workingDirectory
      : dutDirectory;
    const supportPath = join(supportRoot, supportFile.relativePath);
    mkdirSync(dirname(supportPath), { recursive: true });
    writeFileSync(supportPath, supportFile.text, "utf8");
  }
  writeFileSync(dutPath, dutText, "utf8");
  writeFileSync(testbenchPath, testbenchText, "utf8");
  writeFileSync(watchdogPath, watchdogSource(watchdogModule, label), "utf8");
  if (machineCode) {
    writeFileSync(join(workingDirectory, "code.txt"), machineCode, "utf8");
  }

  runCommand(
    iverilog,
    [
      "-g2005",
      ...includeArgsFor([dutPath, testbenchPath, watchdogPath]),
      "-t",
      "vvp",
      "-s",
      testbenchName,
      "-s",
      watchdogModule,
      "-o",
      outputPath,
      dutPath,
      testbenchPath,
      watchdogPath,
    ],
    workingDirectory,
  );
  const simulation = runCommand(vvp, ["-N", outputPath], workingDirectory);
  assertIncludes(simulation.stdout, `CO_COURSE_WATCHDOG=${label}`, `${label} watchdog`);
  verifyOutput(simulation.stdout);
  console.log(`CO_IVERILOG_COURSE_SMOKE=${label}`);
}

let cachedBuildTestbench;

function loadTestbenchBuilder(module, testbenchName, options) {
  if (!cachedBuildTestbench) {
    // Set by the first call from verifyBundledIverilogCourseCompatibility.
    throw new Error("Course testbench builder was not initialized.");
  }
  return cachedBuildTestbench(module, testbenchName, options);
}

function requireProfilePorts(courseConfig, profile) {
  const ports = courseConfig?.verilogPorts?.[profile];
  if (!Array.isArray(ports) || ports.length === 0) {
    throw new Error(`Packaged courseConfig has no Verilog port contract for ${profile}.`);
  }
  return ports;
}

function verilogModule(name, ports) {
  return {
    name,
    ports: ports.map((port) => ({
      name: port.name,
      kind: port.direction,
      direction: port.direction,
      width: verilogWidth(port.width),
    })),
  };
}

function verilogWidth(width) {
  return width > 1 ? `[${width - 1}:0]` : undefined;
}

function moduleHeader(name, ports) {
  const declarations = ports.map((port, index) => {
    const direction = port.direction === "output" ? "output reg" : "input wire";
    const width = verilogWidth(port.width);
    const comma = index === ports.length - 1 ? "" : ",";
    return `    ${direction}${width ? ` ${width}` : ""} ${port.name}${comma}`;
  });
  return [`module ${name}(`, ...declarations, ");"].join("\n");
}

function p1Dut(ports) {
  return [
    "`timescale 1ns/1ps",
    "`include \"defs.vh\"",
    "`include \"workspace root defs.vh\"",
    moduleHeader("main", ports),
    "    reg emitted;",
    "    always @(posedge clk) begin",
    "        if (reset) begin",
    "            result <= 0;",
    "            emitted <= 0;",
    "        end else if (!emitted) begin",
    "            result <= (`CO_P1_VALUE | `CO_P1_ROOT_MASK);",
    '            $display("CO_COURSE_P1 result=%02h", (`CO_P1_VALUE | `CO_P1_ROOT_MASK));',
    "            emitted <= 1;",
    "        end",
    "    end",
    "endmodule",
    "",
  ].join("\n");
}

function p4Dut(ports) {
  return [
    "`timescale 1ns/1ps",
    moduleHeader("mips", ports),
    "    reg emitted;",
    "    always @(posedge clk) begin",
    "        if (reset) emitted <= 0;",
    "        else if (!emitted) begin",
    '            $display("@%h: $%0d <= %h", 32\'h00003000, 5\'d1, 32\'h12345678);',
    "            emitted <= 1;",
    "        end",
    "    end",
    "endmodule",
    "",
  ].join("\n");
}

function p5Dut(ports) {
  return [
    "`timescale 1ns/1ps",
    moduleHeader("mips", ports),
    "    integer cycles;",
    "    reg emitted;",
    "    always @(posedge clk) begin",
    "        if (reset) begin",
    "            cycles <= 0;",
    "            emitted <= 0;",
    "        end else begin",
    "            cycles <= cycles + 1;",
    "            if (cycles == 2 && !emitted) begin",
    '                $display("%0d@%h: $%0d <= %h", $time, 32\'h00003008, 5\'d2, 32\'h89abcdef);',
    "                emitted <= 1;",
    "            end",
    "        end",
    "    end",
    "endmodule",
    "",
  ].join("\n");
}

function p6Dut(ports) {
  return [
    "`timescale 1ns/1ps",
    moduleHeader("mips", ports),
    "    reg emitted;",
    "    always @(posedge clk) begin",
    "        if (reset) begin",
    "            emitted <= 0;",
    "            i_inst_addr <= 32'h00003000;",
    "            m_data_addr <= 0;",
    "            m_data_wdata <= 0;",
    "            m_data_byteen <= 0;",
    "            m_inst_addr <= 0;",
    "            w_grf_addr <= 0;",
    "            w_grf_wdata <= 0;",
    "            w_grf_we <= 0;",
    "            w_inst_addr <= 0;",
    "        end else if (!emitted) begin",
    "            m_data_addr <= 32'h00000004;",
    "            m_data_wdata <= 32'hcafebabe;",
    "            m_data_byteen <= 4'hf;",
    "            m_inst_addr <= 32'h00003004;",
    "            w_grf_addr <= 5'd1;",
    "            w_grf_wdata <= i_inst_rdata;",
    "            w_grf_we <= 1;",
    "            w_inst_addr <= 32'h00003000;",
    "            emitted <= 1;",
    "        end else begin",
    "            m_data_byteen <= 0;",
    "            w_grf_we <= 0;",
    "        end",
    "    end",
    "endmodule",
    "",
  ].join("\n");
}

function p7Dut(ports) {
  return [
    "`timescale 1ns/1ps",
    moduleHeader("mips", ports),
    "    reg emitted;",
    "    reg saw_interrupt;",
    "    reg arm_write_done;",
    "    always @(posedge clk) begin",
    "        if (reset) begin",
    "            emitted <= 0;",
    "            saw_interrupt <= 0;",
    "            arm_write_done <= 0;",
    "            macroscopic_pc <= 32'h00003000;",
    "            i_inst_addr <= 32'h00003000;",
    "            m_data_addr <= 0;",
    "            m_data_wdata <= 0;",
    "            m_data_byteen <= 0;",
    "            m_int_addr <= 0;",
    "            m_int_byteen <= 0;",
    "            m_inst_addr <= 0;",
    "            w_grf_addr <= 0;",
    "            w_grf_wdata <= 0;",
    "            w_grf_we <= 0;",
    "            w_inst_addr <= 0;",
    "        end else begin",
    "            macroscopic_pc <= 32'h00003010;",
    "            i_inst_addr <= 32'h00003000;",
    "            if (!emitted) begin",
    "                w_grf_addr <= 5'd3;",
    "                w_grf_wdata <= 32'h13579bdf;",
    "                w_grf_we <= 1;",
    "                w_inst_addr <= 32'h00003010;",
    "                emitted <= 1;",
    "            end else begin",
    "                w_grf_we <= 0;",
    "            end",
    "            if (!arm_write_done) begin",
    "                m_data_addr <= 32'h000027d0;",
    "                m_data_wdata <= 32'h00000007;",
    "                m_data_byteen <= 4'hf;",
    "                m_inst_addr <= 32'h0000300c;",
    "                arm_write_done <= 1;",
    "            end else begin",
    "                m_data_byteen <= 0;",
    "            end",
    "            if (interrupt) begin",
    "                m_int_addr <= 32'h00007f20;",
    "                m_int_byteen <= 4'hf;",
    "                if (!saw_interrupt) begin",
    '                    $display("CO_COURSE_P7_INTERRUPT");',
    "                    saw_interrupt <= 1;",
    "                end",
    "            end else begin",
    "                m_int_byteen <= 0;",
    "            end",
    "        end",
    "    end",
    "endmodule",
    "",
  ].join("\n");
}

function courseMachineCode(firstWord) {
  return Array.from(
    { length: courseInstructionWords },
    (_unused, index) => (index === 0 ? firstWord : "00000000"),
  ).join("\n") + "\n";
}

function watchdogSource(moduleName, label) {
  return [
    "`timescale 1ps/1ps",
    `module ${moduleName};`,
    "    initial begin",
    `        #(${courseWatchdogLimitPs});`,
    `        $display("CO_COURSE_WATCHDOG=${label}");`,
    "        #1;",
    "        $finish;",
    "    end",
    "endmodule",
    "",
  ].join("\n");
}

function assertTraceEvent(parseSimOutput, stdout, expected, label) {
  const events = parseSimOutput(stdout);
  const expectedPc = expected.pc.toUpperCase();
  const expectedTarget = expected.target.toUpperCase();
  const expectedValue = expected.value.toUpperCase();
  const found = events.find((event) =>
    event.pc === expectedPc
      && event.kind === expected.kind
      && event.target === expectedTarget
      && event.value === expectedValue
      && (!expected.requireCycle || Number.isFinite(event.cycle)));
  if (!found) {
    throw new Error(
      `${label} was not accepted by the packaged Trace parser.\n${stdout}`,
    );
  }
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} is missing ${JSON.stringify(expected)}.\n${text}`);
  }
}

function assertNotIncludes(text, unexpected, label) {
  if (text.includes(unexpected)) {
    throw new Error(`${label} unexpectedly contains ${JSON.stringify(unexpected)}.\n${text}`);
  }
}

function assertOrdered(text, expected, label) {
  let previousIndex = -1;
  for (const sentinel of expected) {
    const index = text.indexOf(sentinel);
    if (index <= previousIndex) {
      throw new Error(
        `${label} did not emit ${JSON.stringify(sentinel)} in order.\n${text}`,
      );
    }
    previousIndex = index;
  }
}
