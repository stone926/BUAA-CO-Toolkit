#!/usr/bin/env node
/**
 * check-index.mjs — 检查 @index 注解和模块索引之间的一致性
 *
 * 用法: node scripts/check-index.mjs [--strict]
 *
 * 检查项:
 *   1. 孤儿 .ts 文件（未被任何索引引用的源文件）
 *   2. 过时的索引引用（指向不存在的文件路径）
 *   3. 缺少 @index 标签的已索引文件（info 级别，--strict 时升级为 warning）
 *   4. @index 的 module-name 与实际归属不一致
 *   5. 文件被多个模块重复索引
 *
 * 退出码: 0=无 error（默认允许 warning）, 1=--strict 下有 warning, 2=error
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const DOCS_MODULES = join(ROOT, 'docs', 'modules');
const DOCS_INDEX = join(ROOT, 'docs', 'INDEX.md');

const STRICT = process.argv.includes('--strict');

// ---- Scan @index annotations in .ts files ----
function scanIndexAnnotations() {
  /** @type {Map<string, {module: string, role: string, desc: string}>} */
  const annotations = new Map();
  const files = walkFiles(SRC, '.ts');
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const match = content.match(/\/\/\s*@index\s+(\S+?)\s*[—\-]\s*(.+)$/m);
    if (match) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      annotations.set(rel, {
        module: '', // no longer in annotation; inferred from path
        role: match[1].trim(),
        desc: match[2].trim()
      });
    }
  }
  return { annotations, files };
}

// ---- Scan index .md files for source references ----
function scanIndexReferences() {
  /** @type {Map<string, {moduleFile: string, modules: Set<string>}>} */
  const indexedFiles = new Map();
  const indexFiles = walkFiles(DOCS_MODULES, '.md');
  // Also scan the top-level INDEX.md
  if (existsSync(DOCS_INDEX)) {
    indexFiles.push(DOCS_INDEX);
  }
  for (const idxFile of indexFiles) {
    const content = readFileSync(idxFile, 'utf8');
    const moduleName = basename(idxFile, '.md');

    // Extract base directory from header: # name | src/path/ | N files
    const headerMatch = content.match(/^#\s+\S+\s*\|\s*(src\/[\w/]*)\s*\|/m);
    const baseDir = headerMatch ? headerMatch[1].replace(/\/$/, '') : null;

    // Match bare src/ paths ending in .ts (full paths)
    const fullPathRe = /\b(src\/[\w/-]+\.ts)\b/g;
    let match;
    while ((match = fullPathRe.exec(content)) !== null) {
      const rel = match[1].replace(/\\/g, '/');
      addRef(rel, moduleName);
    }

    // Match relative file.ts when baseDir is known
    if (baseDir) {
      // Match relative paths like file.ts or subdir/file.ts
      // Negative lookbehind prevents sub-matches from full src/ paths or dotted names
      const relFileRe = /(?<![\w.\/-])([\w\/-]+\.ts)\b/g;
      while ((match = relFileRe.exec(content)) !== null) {
        const filename = match[1];
        if (filename.endsWith('.md')) continue;
        // Exclude full paths already matched by the src/... regex
        if (filename.startsWith('src/')) continue;
        if (/^[a-z][\w\/-]*\.ts$/.test(filename)) {
          const rel = `${baseDir}/${filename}`;
          addRef(rel, moduleName);
        }
      }
    }
  }

  function addRef(rel, moduleName) {
    let entry = indexedFiles.get(rel);
    if (!entry) {
      entry = { moduleFile: moduleName, modules: new Set() };
      indexedFiles.set(rel, entry);
    }
    entry.modules.add(moduleName);
  }

  return { indexedFiles, indexFiles };
}

// ---- Check 1: Orphaned .ts files ----
function checkOrphans(sourceFiles, indexedFiles) {
  const orphans = [];
  for (const file of sourceFiles) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (rel.includes('/test/') || rel.includes('/fixtures/')) continue;
    if (!indexedFiles.has(rel) && !rel.startsWith('node_modules/')) {
      orphans.push(rel);
    }
  }
  return orphans;
}

// ---- Check 2: Stale index references ----
function checkStaleRefs(indexedFiles) {
  const stale = [];
  for (const [rel] of indexedFiles) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) {
      stale.push(rel);
    }
  }
  return stale;
}

// ---- Check 3: Missing @index tags ----
function checkMissingTags(indexedFiles, annotations) {
  const missing = [];
  for (const [rel, entry] of indexedFiles) {
    if (!annotations.has(rel)) {
      missing.push({ file: rel, module: entry.moduleFile });
    }
  }
  return missing;
}

// ---- Check 4: Module consistency (path-based, since @index no longer carries module name) ----
// Skipped — module is now inferred from file path, not annotation.

// ---- Check 5: Duplicate indexing ----
function checkDuplicates(indexedFiles) {
  const dupes = [];
  for (const [rel, entry] of indexedFiles) {
    if (entry.modules.size > 1) {
      dupes.push({ file: rel, modules: [...entry.modules] });
    }
  }
  return dupes;
}

// ---- Helpers ----
function walkFiles(dir, ext) {
  /** @type {string[]} */
  const result = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
        result.push(...walkFiles(full, ext));
      } else if (entry.isFile() && full.endsWith(ext)) {
        result.push(full);
      }
    }
  } catch { /* dir may not exist */ }
  return result;
}

// ---- Main ----
const { annotations, files: sourceFiles } = scanIndexAnnotations();
const { indexedFiles } = scanIndexReferences();

let exitCode = 0;
let warnings = 0;
let errors = 0;

// 1. Orphans
const orphans = checkOrphans(sourceFiles, indexedFiles);
if (orphans.length) {
  console.warn(`\nWARNING: ${orphans.length} 个源文件未被任何索引引用（孤儿文件）:`);
  for (const file of orphans.sort()) {
    console.warn(`  - ${file}`);
  }
  warnings += orphans.length;
}

// 2. Stale refs
const stale = checkStaleRefs(indexedFiles);
if (stale.length) {
  console.error(`\nERROR: ${stale.length} 个索引引用指向不存在的文件:`);
  for (const file of stale.sort()) {
    console.error(`  - ${file}`);
  }
  errors += stale.length;
}

// 3. Missing @index tags
const missingTags = checkMissingTags(indexedFiles, annotations);
if (missingTags.length) {
  const label = STRICT ? 'WARNING' : 'INFO';
  console.warn(`\n${label}: ${missingTags.length} 个已索引文件缺少 @index 标签${STRICT ? '' : '（用 --strict 升级为 warning）'}:`);
  for (const { file, module } of missingTags.sort((a, b) => a.file.localeCompare(b.file))) {
    console.warn(`  - ${file} (归属于 ${module})`);
  }
  if (STRICT) warnings += missingTags.length;
}

// 4. Duplicates
const dupes = checkDuplicates(indexedFiles);
if (dupes.length) {
  console.warn(`\nWARNING: ${dupes.length} 个文件被多个模块索引引用:`);
  for (const { file, modules } of dupes) {
    console.warn(`  - ${file}: [${modules.join(', ')}]`);
  }
  warnings += dupes.length;
}

// Summary
console.log(`\n--- 检查完成 ---`);
console.log(`源文件总数: ${sourceFiles.length}`);
console.log(`有 @index 标签的文件: ${annotations.size}`);
console.log(`索引引用的文件: ${indexedFiles.size}`);
console.log(`错误: ${errors}, 警告: ${warnings}`);

if (errors > 0) exitCode = 2;
else if (STRICT && warnings > 0) exitCode = 1;
else console.log(warnings > 0 ? '无错误（warning 已允许）' : '全部通过');

process.exit(exitCode);
