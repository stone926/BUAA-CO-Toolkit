#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { verifyBundledIverilogCourseCompatibility } from "./verify-bundled-iverilog-course.mjs";

if (process.platform !== "win32" || process.arch !== "x64") {
  fail(`Bundled Icarus smoke requires win32-x64; got ${process.platform}-${process.arch}.`);
}

const extensionRoot = resolve(process.argv[2] ?? ".");
const runtimeRoot = join(extensionRoot, "vendor", "iverilog", "win32-x64");
const binDir = join(runtimeRoot, "bin");
const iverilog = join(binDir, "iverilog.exe");
const vvp = join(binDir, "vvp.exe");

assertOneFile(
  [join(extensionRoot, "LICENSE"), join(extensionRoot, "LICENSE.txt")],
  "LICENSE or LICENSE.txt",
);
assertFile(join(extensionRoot, "package.json"), "package.json");
assertFile(
  join(extensionRoot, "out", "language", "verilog", "moduleUtils.js"),
  "out/language/verilog/moduleUtils.js",
);
assertFile(
  join(extensionRoot, "out", "language", "verilog", "traceParser.js"),
  "out/language/verilog/traceParser.js",
);
assertFile(
  join(extensionRoot, "out", "verilog", "iverilogRuntime.js"),
  "out/verilog/iverilogRuntime.js",
);
const extensionManifest = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
if (extensionManifest.license !== "SEE LICENSE IN LICENSE") {
  fail(`Unexpected extension license field: ${extensionManifest.license ?? "<missing>"}`);
}

const requiredFiles = [
  "bin/iverilog.exe",
  "bin/iverilog-vpi.exe",
  "bin/vvp.exe",
  "bin/libatomic-1.dll",
  "bin/libbz2-1.dll",
  "bin/libgcc_s_seh-1.dll",
  "bin/libgomp-1.dll",
  "bin/libhistory8.dll",
  "bin/libquadmath-0.dll",
  "bin/libreadline8.dll",
  "bin/libstdc++-6.dll",
  "bin/libtermcap-0.dll",
  "bin/libwinpthread-1.dll",
  "bin/zlib1.dll",
  "lib/ivl/ivl.exe",
  "lib/ivl/ivlpp.exe",
  "lib/ivl/null.tgt",
  "lib/ivl/system.vpi",
  "lib/ivl/vvp.tgt",
  "CORRESPONDING_SOURCES.json",
  "THIRD_PARTY_NOTICES.md",
  "licenses/iverilog-COPYING.txt",
  "licenses/bzip2-LICENSE.txt",
  "licenses/readline-COPYING.txt",
  "licenses/zlib-LICENSE.txt",
  "licenses/termcap-COPYING.txt",
  "licenses/gcc-libs-COPYING.LIB.txt",
  "licenses/gcc-libs-COPYING.RUNTIME.txt",
  "licenses/gcc-libs-COPYING3.txt",
  "licenses/gcc-libs-README.txt",
  "licenses/winpthreads-COPYING.txt",
];

for (const relativePath of requiredFiles) {
  assertFile(join(runtimeRoot, ...relativePath.split("/")), relativePath);
}

const notice = readFileSync(join(runtimeRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
const sourceManifest = JSON.parse(
  readFileSync(join(runtimeRoot, "CORRESPONDING_SOURCES.json"), "utf8"),
);
if (sourceManifest.schemaVersion !== 1 || sourceManifest.sources?.length !== 7) {
  fail("CORRESPONDING_SOURCES.json must contain the seven exact source archives.");
}
for (const source of sourceManifest.sources) {
  if (
    typeof source.file !== "string" || !source.file.endsWith(".src.tar.zst") ||
    typeof source.url !== "string" || !source.url.startsWith("https://mirror.msys2.org/mingw/sources/") ||
    typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256) ||
    !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0 ||
    !notice.includes(source.url) || !notice.includes(source.sha256)
  ) {
    fail(`Invalid or undocumented corresponding-source entry: ${JSON.stringify(source)}`);
  }
}
for (const expected of [
  "Icarus Verilog 13.0",
  "mingw-w64-ucrt-x86_64-iverilog",
  "Corresponding source",
]) {
  if (!notice.includes(expected)) {
    fail(`THIRD_PARTY_NOTICES.md is missing: ${expected}`);
  }
}

const isolatedEnv = isolatedEnvironment(binDir);

const version = run(iverilog, ["-V"], extensionRoot, isolatedEnv);
const versionText = `${version.stdout}\n${version.stderr}`;
if (!/Icarus Verilog version 13\.0\b/.test(versionText)) {
  fail(`Unexpected bundled Icarus version:\n${versionText.trim()}`);
}
if (version.stderr.trim() || /Failed to open|\berror:/i.test(versionText)) {
  fail(`Bundled Icarus preflight reported a runtime loading error:\n${versionText.trim()}`);
}

const smokeRoot = mkdtempSync(join(tmpdir(), "co-iverilog-中文 path-"));
let courseSmokeLabels = [];
try {
  const sourcePath = join(smokeRoot, "tiny smoke.v");
  const outputPath = join(smokeRoot, "tiny simulation.vvp");
  writeFileSync(
    sourcePath,
    [
      "module tiny_smoke;",
      "  reg [7:0] memory [0:0];",
      "  initial begin",
      '    $readmemh("code.txt", memory);',
      '    $display("CO_IVERILOG_SMOKE=%02h", memory[0]);',
      "    $finish;",
      "  end",
      "endmodule",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(smokeRoot, "code.txt"), "2a\n", "utf8");

  run(iverilog, ["-g2005", "-tnull", "-i", sourcePath], smokeRoot, isolatedEnv);

  const syntaxFailurePath = join(smokeRoot, "intentional syntax failure.v");
  writeFileSync(
    syntaxFailurePath,
    [
      "module intentional_syntax_failure;",
      "  this is invalid;",
      "endmodule",
      "",
    ].join("\n"),
    "utf8",
  );
  const syntaxFailure = execute(
    iverilog,
    ["-g2005", "-tnull", "-i", syntaxFailurePath],
    smokeRoot,
    isolatedEnv,
  );
  if (syntaxFailure.error) {
    fail(`${iverilog} failed to start: ${syntaxFailure.error.message}`);
  }
  const syntaxFailureOutput = `${syntaxFailure.stdout}\n${syntaxFailure.stderr}`;
  if (
    syntaxFailure.status === 0
      || !/intentional syntax failure\.v:2(?::\d+)?:/i.test(syntaxFailureOutput)
      || !/syntax error/i.test(syntaxFailureOutput)
  ) {
    fail(`Intentional syntax failure did not report the expected file and line:\n${syntaxFailureOutput}`);
  }

  run(
    iverilog,
    ["-g2005", "-t", "vvp", "-s", "tiny_smoke", "-o", outputPath, sourcePath],
    smokeRoot,
    isolatedEnv,
  );
  const simulation = run(vvp, ["-N", outputPath], smokeRoot, isolatedEnv);
  if (!simulation.stdout.includes("CO_IVERILOG_SMOKE=2a")) {
    fail(`Unexpected VVP output:\n${simulation.stdout}${simulation.stderr}`);
  }

  const watchdogSource = join(smokeRoot, "watchdog smoke.v");
  const watchdogOutput = join(smokeRoot, "watchdog smoke.vvp");
  writeFileSync(
    watchdogSource,
    [
      "module permanent_clock;",
      "  reg clk = 0;",
      "  always #1 clk = ~clk;",
      "endmodule",
      "module co_watchdog;",
      "  initial begin",
      "    #8;",
      '    $display("CO_IVERILOG_WATCHDOG");',
      "    $finish;",
      "  end",
      "endmodule",
      "",
    ].join("\n"),
    "utf8",
  );
  run(
    iverilog,
    [
      "-g2005",
      "-t",
      "vvp",
      "-s",
      "permanent_clock",
      "-s",
      "co_watchdog",
      "-o",
      watchdogOutput,
      watchdogSource,
    ],
    smokeRoot,
    isolatedEnv,
  );
  const watchdog = run(vvp, ["-N", watchdogOutput], smokeRoot, isolatedEnv);
  if (!watchdog.stdout.includes("CO_IVERILOG_WATCHDOG")) {
    fail(`Watchdog did not terminate the permanent clock:\n${watchdog.stdout}${watchdog.stderr}`);
  }

  const stopSource = join(smokeRoot, "stop smoke.v");
  const stopOutput = join(smokeRoot, "stop smoke.vvp");
  writeFileSync(
    stopSource,
    [
      "module stop_smoke;",
      "  initial begin",
      "    $stop;",
      "  end",
      "endmodule",
      "",
    ].join("\n"),
    "utf8",
  );
  run(
    iverilog,
    ["-g2005", "-t", "vvp", "-s", "stop_smoke", "-o", stopOutput, stopSource],
    smokeRoot,
    isolatedEnv,
  );
  const stopped = execute(vvp, ["-N", stopOutput], smokeRoot, isolatedEnv);
  if (stopped.error) {
    fail(`${vvp} failed to start: ${stopped.error.message}`);
  }
  if (stopped.status === 0) {
    fail("vvp -N unexpectedly accepted $stop with exit code 0.");
  }

  courseSmokeLabels = verifyBundledIverilogCourseCompatibility({
    extensionRoot,
    workingDirectory: smokeRoot,
    iverilog,
    vvp,
    runCommand: (command, args, cwd) => run(command, args, cwd, isolatedEnv),
  });
} finally {
  rmSync(smokeRoot, { force: true, recursive: true });
}

console.log(
  `Bundled Icarus 13.0 passed isolated -V, syntax success/failure, nested includes, compile/run, watchdog, $stop, and course compatibility smokes (${courseSmokeLabels.join(", ")}; P7 probe armed).`,
);

function assertFile(path, label) {
  try {
    if (!statSync(path).isFile()) {
      fail(`Required runtime entry is not a file: ${label}`);
    }
  } catch {
    fail(`Required runtime file is missing: ${label}`);
  }
}

function assertOneFile(paths, label) {
  for (const path of paths) {
    try {
      if (statSync(path).isFile()) {
        return;
      }
    } catch {
      // Try the next packaging-compatible filename.
    }
  }
  fail(`Required runtime file is missing: ${label}`);
}

function isolatedPath(runtimeBin) {
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  return [runtimeBin, join(windowsRoot, "System32"), windowsRoot].join(delimiter);
}

function isolatedEnvironment(runtimeBin) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  env.PATH = isolatedPath(runtimeBin);
  return env;
}

function run(command, args, cwd, env) {
  const result = execute(command, args, cwd, env);

  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      [
        `${command} ${args.join(" ")} exited with ${result.status}.`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function execute(command, args, cwd, env) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
