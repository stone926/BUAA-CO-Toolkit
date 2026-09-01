#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const extensionRoot = resolve(process.argv[2] ?? ".");
const runtime = resolveRuntime(process.platform, process.arch);
if (!runtime) {
  fail(`Bundled Icarus smoke does not support ${process.platform}-${process.arch}.`);
}
const runtimeRoot = join(extensionRoot, "vendor", "iverilog", runtime.target);
const binDir = join(runtimeRoot, "bin");
const libDir = join(runtimeRoot, "lib", "ivl");
const iverilog = join(binDir, runtime.iverilogExecutable);
const vvp = join(binDir, runtime.vvpExecutable);
const iverilogRuntimeArgs = runtime.target.startsWith("darwin-")
  ? ["-B", libDir]
  : [];
const withRuntimeArgs = (args) => [...iverilogRuntimeArgs, ...args];
const utf8ManifestExecutables = [
  "bin/iverilog-vpi.exe",
  "bin/iverilog.exe",
  "bin/vvp.exe",
  "lib/ivl/ivl.exe",
  "lib/ivl/ivlpp.exe",
  "lib/ivl/vhdlpp.exe",
];

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

const commonRequiredFiles = [
  `bin/${runtime.iverilogExecutable}`,
  `bin/${runtime.iverilogVpiExecutable}`,
  `bin/${runtime.vvpExecutable}`,
  `lib/ivl/${runtime.ivlExecutable}`,
  `lib/ivl/${runtime.ivlppExecutable}`,
  `lib/ivl/${runtime.vhdlppExecutable}`,
  "lib/ivl/null.tgt",
  "lib/ivl/system.vpi",
  "lib/ivl/vvp.tgt",
  "THIRD_PARTY_NOTICES.md",
  "licenses/iverilog-COPYING.txt",
];
const windowsRequiredFiles = [
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
  "CORRESPONDING_SOURCES.json",
  "UTF8_MANIFEST_PATCH.json",
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
const darwinRequiredFiles = [
  ".brew/icarus-verilog.rb",
  "BOTTLE_MANIFEST.json",
  "COPYING",
  "README.md",
  "include/iverilog/vpi_user.h",
  "lib/libvpi.a",
  "sbom.spdx.json",
  "share/man/man1/iverilog-vpi.1",
  "share/man/man1/iverilog.1",
  "share/man/man1/vvp.1",
];
const requiredFiles = [
  ...commonRequiredFiles,
  ...(runtime.target === "win32-x64" ? windowsRequiredFiles : darwinRequiredFiles),
];

for (const relativePath of requiredFiles) {
  assertFile(join(runtimeRoot, ...relativePath.split("/")), relativePath);
}

if (runtime.target === "win32-x64") {
  verifyWindowsRuntimeMetadata(runtimeRoot);
} else {
  verifyDarwinRuntimeMetadata(extensionRoot, runtimeRoot, runtime);
}

const isolatedEnv = isolatedEnvironment(binDir);

const version = run(iverilog, withRuntimeArgs(["-V"]), extensionRoot, isolatedEnv);
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

  run(
    iverilog,
    withRuntimeArgs(["-g2005", "-tnull", "-i", sourcePath]),
    smokeRoot,
    isolatedEnv,
  );

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
    withRuntimeArgs(["-g2005", "-tnull", "-i", syntaxFailurePath]),
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
    withRuntimeArgs([
      "-g2005",
      "-t",
      "vvp",
      "-s",
      "tiny_smoke",
      "-o",
      outputPath,
      sourcePath,
    ]),
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
    withRuntimeArgs([
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
    ]),
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
    withRuntimeArgs([
      "-g2005",
      "-t",
      "vvp",
      "-s",
      "stop_smoke",
      "-o",
      stopOutput,
      stopSource,
    ]),
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
    iverilogArgs: iverilogRuntimeArgs,
    selectedLabels: runtime.target.startsWith("darwin-")
      ? ["P7-probe"]
      : undefined,
    runCommand: (command, args, cwd) => run(command, args, cwd, isolatedEnv),
  });
} finally {
  rmSync(smokeRoot, { force: true, recursive: true });
}

const courseCoverage = runtime.target === "win32-x64"
  ? "nested includes and full course compatibility"
  : "representative course compatibility";
console.log(
  `Bundled Icarus 13.0 passed isolated -V, syntax success/failure, compile/run, watchdog, $stop, plus ${courseCoverage} smokes (${courseSmokeLabels.join(", ")}; P7 probe armed).`,
);

function resolveRuntime(platform, arch) {
  const common = {
    iverilogVpiExecutable: platform === "win32" ? "iverilog-vpi.exe" : "iverilog-vpi",
    ivlExecutable: platform === "win32" ? "ivl.exe" : "ivl",
    ivlppExecutable: platform === "win32" ? "ivlpp.exe" : "ivlpp",
    vhdlppExecutable: platform === "win32" ? "vhdlpp.exe" : "vhdlpp",
  };
  if (platform === "win32" && arch === "x64") {
    return {
      ...common,
      target: "win32-x64",
      iverilogExecutable: "iverilog.exe",
      vvpExecutable: "vvp.exe",
    };
  }
  if (platform === "darwin" && arch === "arm64") {
    return {
      ...common,
      target: "darwin-arm64",
      iverilogExecutable: "iverilog",
      vvpExecutable: "vvp",
      bottle: {
        tag: "arm64_sonoma",
        cellar: "/opt/homebrew/Cellar",
        url: "https://ghcr.io/v2/homebrew/core/icarus-verilog/blobs/sha256:936627d8dfbb9996d55b3f3044f6bdf45e433df0c5fe9d0f8390f1a35714978b",
        sha256: "936627d8dfbb9996d55b3f3044f6bdf45e433df0c5fe9d0f8390f1a35714978b",
        sizeBytes: 2140973,
      },
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      ...common,
      target: "darwin-x64",
      iverilogExecutable: "iverilog",
      vvpExecutable: "vvp",
      bottle: {
        tag: "sonoma",
        cellar: "/usr/local/Cellar",
        url: "https://ghcr.io/v2/homebrew/core/icarus-verilog/blobs/sha256:2eb03352145134b01eec88e2426a5bb066952c60f13c5d8b90067c6674ab56fe",
        sha256: "2eb03352145134b01eec88e2426a5bb066952c60f13c5d8b90067c6674ab56fe",
        sizeBytes: 2270344,
      },
    };
  }
  return undefined;
}

function verifyWindowsRuntimeMetadata(runtimeRoot) {
  const manifestPatch = JSON.parse(
    readFileSync(join(runtimeRoot, "UTF8_MANIFEST_PATCH.json"), "utf8"),
  );
  if (
    manifestPatch.schemaVersion !== 1 ||
    !Array.isArray(manifestPatch.targets) ||
    manifestPatch.targets.length !== 6
  ) {
    fail("UTF8_MANIFEST_PATCH.json must describe the six patched executables.");
  }
  const manifestPatchTargets = new Map(
    manifestPatch.targets.map((target) => [target.path, target]),
  );
  for (const relativePath of utf8ManifestExecutables) {
    const target = manifestPatchTargets.get(relativePath);
    if (
      !target ||
      typeof target.originalSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(target.originalSha256) ||
      typeof target.patchedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(target.patchedSha256)
    ) {
      fail(`Missing or invalid UTF-8 manifest patch metadata: ${relativePath}`);
    }
    const executablePath = join(runtimeRoot, ...relativePath.split("/"));
    assertUtf8ActiveCodePage(executablePath, relativePath);
    assertValidPeMetadata(executablePath, relativePath);
    const actualSha256 = createHash("sha256")
      .update(readFileSync(executablePath))
      .digest("hex");
    if (actualSha256 !== target.patchedSha256) {
      fail(`Unexpected patched executable hash for ${relativePath}: ${actualSha256}`);
    }
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
}

function verifyDarwinRuntimeMetadata(extensionRoot, runtimeRoot, runtime) {
  const executablePaths = [
    `bin/${runtime.iverilogExecutable}`,
    `bin/${runtime.iverilogVpiExecutable}`,
    `bin/${runtime.vvpExecutable}`,
    `lib/ivl/${runtime.ivlExecutable}`,
    `lib/ivl/${runtime.ivlppExecutable}`,
    `lib/ivl/${runtime.vhdlppExecutable}`,
  ];
  for (const relativePath of executablePaths) {
    assertExecutable(
      join(runtimeRoot, ...relativePath.split("/")),
      relativePath,
    );
  }

  const bottleManifest = JSON.parse(
    readFileSync(join(runtimeRoot, "BOTTLE_MANIFEST.json"), "utf8"),
  );
  if (
    bottleManifest.schemaVersion !== 1
      || bottleManifest.formula?.tap !== "homebrew/core"
      || bottleManifest.formula?.name !== "icarus-verilog"
      || bottleManifest.formula?.version !== "13.0"
      || bottleManifest.formula?.revision !== 0
      || bottleManifest.bottle?.tag !== runtime.bottle.tag
      || bottleManifest.bottle?.rebuild !== 0
      || bottleManifest.bottle?.cellar !== runtime.bottle.cellar
      || bottleManifest.bottle?.url !== runtime.bottle.url
      || bottleManifest.bottle?.sha256 !== runtime.bottle.sha256
      || bottleManifest.bottle?.sizeBytes !== runtime.bottle.sizeBytes
      || bottleManifest.sourceManifest !== "../CORRESPONDING_SOURCES.json"
  ) {
    fail(`Invalid Homebrew bottle metadata for ${runtime.target}.`);
  }

  const sourceManifestPath = join(
    extensionRoot,
    "vendor",
    "iverilog",
    "CORRESPONDING_SOURCES.json",
  );
  assertFile(sourceManifestPath, "vendor/iverilog/CORRESPONDING_SOURCES.json");
  const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
  const source = sourceManifest.sources?.[0];
  if (
    sourceManifest.schemaVersion !== 1
      || sourceManifest.sources?.length !== 1
      || source?.component !== "Icarus Verilog 13.0"
      || source?.file !== "v13_0.tar.gz"
      || source?.url !== "https://github.com/steveicarus/iverilog/archive/refs/tags/v13_0.tar.gz"
      || source?.sha256 !== "c897bbfa9848688982c6d5c30529fc29d68df0b9ff22ffa73bad89db73a7ce49"
      || source?.sizeBytes !== 3215392
  ) {
    fail("Invalid shared macOS corresponding-source manifest.");
  }

  const notice = readFileSync(join(runtimeRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const expected of [
    "Icarus Verilog 13.0",
    "formula revision `0`",
    runtime.bottle.url,
    runtime.bottle.sha256,
    source.url,
    source.sha256,
  ]) {
    if (!notice.includes(expected)) {
      fail(`THIRD_PARTY_NOTICES.md is missing: ${expected}`);
    }
  }

  const formula = readFileSync(
    join(runtimeRoot, ".brew", "icarus-verilog.rb"),
    "utf8",
  );
  for (const expected of [source.url, source.sha256, 'license all_of: ["GPL-2.0-or-later", "LGPL-2.1-or-later"]']) {
    if (!formula.includes(expected)) {
      fail(`Homebrew formula snapshot is missing: ${expected}`);
    }
  }

  const sbom = JSON.parse(readFileSync(join(runtimeRoot, "sbom.spdx.json"), "utf8"));
  const sourcePackage = sbom.packages?.find((entry) => entry.name === "icarus-verilog");
  if (
    sourcePackage?.versionInfo !== "13.0"
      || sourcePackage?.downloadLocation !== source.url
      || !sourcePackage.checksums?.some(
        (checksum) => checksum.algorithm === "SHA256" && checksum.checksumValue === source.sha256,
      )
  ) {
    fail("Homebrew SBOM does not match the corresponding-source manifest.");
  }

  const copyingHash = createHash("sha256")
    .update(readFileSync(join(runtimeRoot, "COPYING")))
    .digest("hex");
  const stableCopyingHash = createHash("sha256")
    .update(readFileSync(join(runtimeRoot, "licenses", "iverilog-COPYING.txt")))
    .digest("hex");
  if (copyingHash !== stableCopyingHash) {
    fail("licenses/iverilog-COPYING.txt does not match the bottle's COPYING file.");
  }
}

function assertFile(path, label) {
  try {
    if (!statSync(path).isFile()) {
      fail(`Required runtime entry is not a file: ${label}`);
    }
  } catch {
    fail(`Required runtime file is missing: ${label}`);
  }
}

function assertExecutable(path, label) {
  let file;
  try {
    file = statSync(path);
  } catch {
    fail(`Required runtime file is missing: ${label}`);
  }
  if (!file.isFile()) {
    fail(`Required runtime entry is not a file: ${label}`);
  }
  if ((file.mode & 0o111) !== 0o111) {
    fail(`Packaged runtime entry is not executable: ${label}`);
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

function assertUtf8ActiveCodePage(path, label) {
  const executableText = readFileSync(path).toString("latin1");
  if (!/<activeCodePage\b[^>]*>\s*UTF-8\s*<\/activeCodePage>/.test(executableText)) {
    fail(`Bundled executable is missing its UTF-8 activeCodePage manifest: ${label}`);
  }
}

function assertValidPeMetadata(path, label) {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) {
    fail(`Bundled executable is not a valid PE image: ${label}`);
  }
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 24 || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    fail(`Bundled executable has an invalid PE header: ${label}`);
  }

  const fileHeaderOffset = peOffset + 4;
  const sectionCount = bytes.readUInt16LE(fileHeaderOffset + 2);
  const symbolTablePointer = bytes.readUInt32LE(fileHeaderOffset + 8);
  const symbolCount = bytes.readUInt32LE(fileHeaderOffset + 12);
  const optionalHeaderSize = bytes.readUInt16LE(fileHeaderOffset + 16);
  const optionalHeaderOffset = fileHeaderOffset + 20;
  const sectionTableOffset = optionalHeaderOffset + optionalHeaderSize;
  if (sectionTableOffset + (sectionCount * 40) > bytes.length) {
    fail(`Bundled executable has a truncated PE section table: ${label}`);
  }

  let rawSectionEnd = 0;
  for (let sectionIndex = 0; sectionIndex < sectionCount; sectionIndex += 1) {
    const sectionOffset = sectionTableOffset + (sectionIndex * 40);
    const rawSize = bytes.readUInt32LE(sectionOffset + 16);
    const rawPointer = bytes.readUInt32LE(sectionOffset + 20);
    rawSectionEnd = Math.max(rawSectionEnd, rawPointer + rawSize);
  }
  if (symbolCount === 0 || symbolTablePointer !== rawSectionEnd) {
    fail(`Bundled executable has an invalid COFF symbol-table pointer: ${label}`);
  }

  const stringTableOffset = symbolTablePointer + (symbolCount * 18);
  if (stringTableOffset + 4 > bytes.length) {
    fail(`Bundled executable has a truncated COFF symbol table: ${label}`);
  }
  const stringTableLength = bytes.readUInt32LE(stringTableOffset);
  if (stringTableLength < 4 || stringTableOffset + stringTableLength !== bytes.length) {
    fail(`Bundled executable has a truncated COFF string table: ${label}`);
  }

  const checksumOffset = optionalHeaderOffset + 64;
  if (checksumOffset + 4 > sectionTableOffset) {
    fail(`Bundled executable has no complete PE checksum field: ${label}`);
  }
  const storedChecksum = bytes.readUInt32LE(checksumOffset);
  const computedChecksum = computePeChecksum(bytes, checksumOffset);
  if (storedChecksum !== computedChecksum) {
    fail(
      `Bundled executable has an invalid PE checksum: ${label} ` +
      `(stored ${storedChecksum}, computed ${computedChecksum})`,
    );
  }
}

function computePeChecksum(bytes, checksumOffset) {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 2) {
    if (offset === checksumOffset || offset === checksumOffset + 2) {
      continue;
    }
    const word = bytes[offset] | ((bytes[offset + 1] ?? 0) << 8);
    sum += word;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  sum = (sum & 0xffff) + (sum >>> 16);
  return ((sum & 0xffff) + bytes.length) >>> 0;
}

function isolatedPath(runtimeBin) {
  if (process.platform !== "win32") {
    return [runtimeBin, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
  }
  const windowsRoot = process.env.SystemRoot ?? "C:\\Windows";
  return [runtimeBin, join(windowsRoot, "System32"), windowsRoot].join(delimiter);
}

function isolatedEnvironment(runtimeBin) {
  const removedVariables = new Set([
    "dyld_fallback_library_path",
    "dyld_library_path",
    "iverilog_iconfig",
    "path",
  ]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !removedVariables.has(key.toLowerCase()),
    ),
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
