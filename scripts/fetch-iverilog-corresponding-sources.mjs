#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestDescriptors = [
  {
    path: join(
      repositoryRoot,
      "vendor",
      "iverilog",
      "win32-x64",
      "CORRESPONDING_SOURCES.json",
    ),
    expectedCount: 7,
    validateLocation(source) {
      return source.file.endsWith(".src.tar.zst")
        && source.url.startsWith("https://mirror.msys2.org/mingw/sources/");
    },
  },
  {
    path: join(
      repositoryRoot,
      "vendor",
      "iverilog",
      "CORRESPONDING_SOURCES.json",
    ),
    expectedCount: 1,
    validateLocation(source) {
      return source.file === "v13_0.tar.gz"
        && source.url === "https://github.com/steveicarus/iverilog/archive/refs/tags/v13_0.tar.gz";
    },
  },
];
const outputDirectory = resolve(process.argv[2] ?? join(repositoryRoot, "dist", "corresponding-sources"));
const sources = deduplicateSources(
  manifestDescriptors.flatMap((descriptor) => {
    const manifest = JSON.parse(readFileSync(descriptor.path, "utf8"));
    return validateManifest(manifest, descriptor);
  }),
);

mkdirSync(outputDirectory, { recursive: true });
for (const source of sources) {
  await ensureSourceArchive(source, outputDirectory);
}
writeFileSync(
  join(outputDirectory, "SHA256SUMS"),
  `${sources.map((source) => `${source.sha256}  ${source.file}`).join("\n")}\n`,
  "utf8",
);
console.log(`Verified ${sources.length} corresponding-source archives in ${outputDirectory}.`);

function validateManifest(value, descriptor) {
  if (
    value?.schemaVersion !== 1
      || !Array.isArray(value.sources)
      || value.sources.length !== descriptor.expectedCount
  ) {
    throw new Error("Invalid corresponding-source manifest schema or entry count.");
  }
  const files = new Set();
  return value.sources.map((source) => {
    if (
      typeof source?.component !== "string" || !source.component.trim() ||
      typeof source?.file !== "string" || basename(source.file) !== source.file ||
      files.has(source.file) ||
      typeof source?.url !== "string" || !descriptor.validateLocation(source) ||
      typeof source?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256) ||
      !Number.isSafeInteger(source?.sizeBytes) || source.sizeBytes <= 0
    ) {
      throw new Error(`Invalid corresponding-source entry: ${JSON.stringify(source)}`);
    }
    files.add(source.file);
    return source;
  });
}

function deduplicateSources(sources) {
  const uniqueSources = [];
  const byUrl = new Map();
  const bySha256 = new Map();
  const byFile = new Map();
  for (const source of sources) {
    const duplicate = byUrl.get(source.url) ?? bySha256.get(source.sha256);
    if (duplicate) {
      if (
        duplicate.url !== source.url
          || duplicate.sha256 !== source.sha256
          || duplicate.file !== source.file
          || duplicate.sizeBytes !== source.sizeBytes
      ) {
        throw new Error(
          `Conflicting duplicate corresponding-source entry: ${JSON.stringify(source)}`,
        );
      }
      continue;
    }
    if (byFile.has(source.file)) {
      throw new Error(`Conflicting corresponding-source filename: ${source.file}`);
    }
    uniqueSources.push(source);
    byUrl.set(source.url, source);
    bySha256.set(source.sha256, source);
    byFile.set(source.file, source);
  }
  return uniqueSources;
}

async function ensureSourceArchive(source, outputDirectory) {
  const outputPath = join(outputDirectory, source.file);
  if (existsSync(outputPath) && await fileMatches(outputPath, source)) {
    console.log(`Reused ${source.file}.`);
    return;
  }
  rmSync(outputPath, { force: true });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const partialPath = `${outputPath}.part-${process.pid}`;
    rmSync(partialPath, { force: true });
    try {
      console.log(`Downloading ${source.file} (attempt ${attempt}/3)...`);
      const response = await fetch(source.url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath, { flags: "wx" }));
      if (!await fileMatches(partialPath, source)) {
        throw new Error(`size or SHA-256 mismatch for ${source.file}`);
      }
      renameSync(partialPath, outputPath);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      rmSync(partialPath, { force: true });
      if (attempt < 3) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1000));
      }
    }
  }
  if (lastError) {
    throw new Error(`Unable to fetch ${source.file}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
}

async function fileMatches(file, source) {
  if (statSync(file).size !== source.sizeBytes) {
    return false;
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex") === source.sha256;
}
