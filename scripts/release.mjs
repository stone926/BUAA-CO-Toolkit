#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith("--")));
const positional = args.filter((arg) => !arg.startsWith("--"));

const knownFlags = new Set(["--dry-run", "--skip-tests", "--no-push"]);
for (const flag of flags) {
  if (!knownFlags.has(flag)) {
    fail(`Unknown flag: ${flag}`);
  }
}

if (positional.length > 1) {
  fail("Usage: npm run publish -- [patch|minor|major|x.y.z] [--dry-run] [--skip-tests] [--no-push]");
}

const dryRun = flags.has("--dry-run");
const skipTests = flags.has("--skip-tests");
const noPush = flags.has("--no-push");
const releaseInput = positional[0] ?? "patch";

const packagePath = "package.json";
const lockPath = "package-lock.json";
const changelogPath = "CHANGELOG.md";

const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
const currentVersion = pkg.version;
const nextVersion = resolveNextVersion(currentVersion, releaseInput);
const tagName = `v${nextVersion}`;

main();

function main() {
  assertGitRepo();

  const status = getGitStatus();
  if (status) {
    if (!dryRun) {
      fail(
        [
          "Working tree is not clean. Commit or stash changes before publishing.",
          "Dirty files:",
          status,
        ].join("\n"),
      );
    }

    console.warn("Working tree is not clean; dry run will continue.");
  }

  assertTagDoesNotExist(tagName);

  const releaseBase = getReleaseBase();
  const notes = getReleaseNotes(releaseBase);

  printPlan(releaseBase, notes);

  if (dryRun) {
    console.log("Dry run complete. No files were changed.");
    return;
  }

  run("npm", ["run", "sync:manifest-config"]);
  assertNoGeneratedChanges();

  if (!skipTests) {
    run("npm", ["test"]);
  }
  run("npm", ["run", "compile"]);

  run("npm", ["version", nextVersion, "--no-git-tag-version"]);
  updateChangelog(nextVersion, notes);

  const filesToStage = [packagePath, lockPath, changelogPath].filter((file) => existsSync(file));
  run("git", ["add", ...filesToStage]);
  run("git", ["commit", "-m", `chore: release ${tagName}`]);
  run("git", ["tag", "-a", tagName, "-m", tagName]);

  if (noPush) {
    console.log(`Created local release commit and tag ${tagName}. Push them when ready.`);
    return;
  }

  run("git", ["push", "origin", "HEAD", "--follow-tags"]);
  console.log(`Pushed ${tagName}. GitHub Actions will package, publish, and create the release.`);
}

function resolveNextVersion(version, input) {
  const parsed = parseVersion(version);
  if (!parsed) {
    fail(`package.json version is not a plain semver version: ${version}`);
  }

  if (input === "major") {
    return `${parsed.major + 1}.0.0`;
  }

  if (input === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }

  if (input === "patch") {
    return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  }

  const exact = parseVersion(input);
  if (!exact) {
    fail(`Invalid release version or bump type: ${input}`);
  }

  if (compareVersions(exact, parsed) <= 0) {
    fail(`Next version ${input} must be greater than current version ${version}.`);
  }

  return input;
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(left, right) {
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }

  return 0;
}

function getReleaseBase() {
  const lastTag = getLastTag();
  if (lastTag) {
    return {
      label: `${lastTag}..HEAD`,
      range: `${lastTag}..HEAD`,
    };
  }

  const upstream = getUpstream();
  if (upstream) {
    return {
      label: `${upstream}..HEAD`,
      range: `${upstream}..HEAD`,
    };
  }

  return {
    label: "full history",
    range: "HEAD",
  };
}

function getLastTag() {
  try {
    return capture("git", ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  } catch {
    return "";
  }
}

function getUpstream() {
  try {
    return capture("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  } catch {
    return "";
  }
}

function getReleaseNotes(releaseBase) {
  let output = "";

  try {
    output = capture("git", ["log", releaseBase.range, "--pretty=format:%s (%h)"]);
  } catch {
    output = "";
  }

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("chore: release v"));

  if (lines.length === 0) {
    return ["- Maintenance release."];
  }

  return lines.map((line) => `- ${line}`);
}

function updateChangelog(version, notes) {
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## [${version}] - ${date}\n\n${notes.join("\n")}\n\n`;
  let content = "# Change Log\n\nAll notable changes to BUAA CO Toolkit are documented in this file.\n";

  if (existsSync(changelogPath)) {
    content = readFileSync(changelogPath, "utf8");
  }

  if (content.includes(`## [${version}]`)) {
    fail(`${changelogPath} already contains an entry for ${version}.`);
  }

  if (!content.startsWith("# Change Log")) {
    content = `# Change Log\n\n${content}`;
  }

  const marker = "\n## [";
  const index = content.indexOf(marker);
  let updated = "";

  if (index === -1) {
    updated = `${content.trimEnd()}\n\n${entry}`;
  } else {
    const prefix = content.slice(0, index).trimEnd();
    const suffix = content.slice(index).trimStart();
    updated = `${prefix}\n\n${entry}${suffix}`;
  }

  writeFileSync(changelogPath, updated, "utf8");
}

function printPlan(releaseBase, notes) {
  console.log(`Release: ${pkg.name} ${currentVersion} -> ${nextVersion}`);
  console.log(`Tag: ${tagName}`);
  console.log(`Commit range: ${releaseBase.label}`);
  console.log("Release notes:");
  for (const note of notes) {
    console.log(note);
  }

  console.log("Steps:");
  console.log("- npm run sync:manifest-config");
  if (!skipTests) {
    console.log("- npm test");
  } else {
    console.log("- tests skipped");
  }
  console.log("- npm run compile");
  console.log("- npm version --no-git-tag-version");
  console.log("- update CHANGELOG.md");
  console.log("- git commit and annotated tag");
  console.log(noPush ? "- skip push" : "- git push origin HEAD --follow-tags");
}

function assertGitRepo() {
  capture("git", ["rev-parse", "--is-inside-work-tree"]);
}

function assertTagDoesNotExist(tag) {
  const existing = capture("git", ["tag", "--list", tag]);
  if (existing) {
    fail(`Tag already exists: ${tag}`);
  }
}

function getGitStatus() {
  return capture("git", ["status", "--porcelain"]);
}

function assertNoGeneratedChanges() {
  const status = getGitStatus();
  if (status) {
    fail(
      [
        "Generated manifest configuration changed files. Review and commit them before publishing.",
        "Dirty files:",
        status,
      ].join("\n"),
    );
  }
}

function run(command, commandArgs) {
  console.log(`> ${[command, ...commandArgs].join(" ")}`);
  const invocation = resolveInvocation(command, commandArgs);
  execFileSync(invocation.file, invocation.args, { stdio: "inherit" });
}

function capture(command, commandArgs) {
  const invocation = resolveInvocation(command, commandArgs);
  return execFileSync(invocation.file, invocation.args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveInvocation(command, commandArgs) {
  if ((process.platform === "win32") && (command === "npm")) {
    const commandLine = ["npm", ...commandArgs].map(quoteCmdArg).join(" ");
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return {
    file: command,
    args: commandArgs,
  };
}

function quoteCmdArg(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
