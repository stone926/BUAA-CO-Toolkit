/**
 * Filesystem membrane for expected-data code.
 *
 * Expected/golden modules may only read or mutate files inside
 * conformance/mips. This makes a dynamically assembled path to production
 * src/resources fail at runtime. check-dependency-whitelist.mjs separately
 * prevents the expected-data dependency closure from importing node:fs
 * directly and bypassing this membrane.
 */
import * as nativeFs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const expectedFilesystemRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedFilesystemRootReal = nativeFs.realpathSync(expectedFilesystemRoot);

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function pathString(value, operation) {
  if (value instanceof URL) {
    if (value.protocol !== 'file:') throw new Error(`expected filesystem ${operation}: only file: URLs are accepted`);
    return fileURLToPath(value);
  }
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value.toString();
  throw new Error(`expected filesystem ${operation}: file descriptors and untyped paths are forbidden`);
}

function assertLexical(value, operation) {
  const resolved = path.resolve(pathString(value, operation));
  if (!isWithin(expectedFilesystemRoot, resolved)) {
    throw new Error(`expected filesystem ${operation}: path escapes conformance/mips: ${resolved}`);
  }
  return resolved;
}

function assertExisting(value, operation) {
  const resolved = assertLexical(value, operation);
  const real = nativeFs.realpathSync(resolved);
  if (!isWithin(expectedFilesystemRootReal, real)) {
    throw new Error(`expected filesystem ${operation}: real path escapes conformance/mips: ${real}`);
  }
  return resolved;
}

function assertWritable(value, operation) {
  const resolved = assertLexical(value, operation);
  if (nativeFs.existsSync(resolved)) return assertExisting(resolved, operation);
  let ancestor = path.dirname(resolved);
  while (!nativeFs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error(`expected filesystem ${operation}: no existing trusted ancestor`);
    ancestor = parent;
  }
  const ancestorReal = nativeFs.realpathSync(ancestor);
  if (!isWithin(expectedFilesystemRootReal, ancestorReal)) {
    throw new Error(`expected filesystem ${operation}: writable ancestor escapes conformance/mips: ${ancestorReal}`);
  }
  return resolved;
}

export function readFileSync(file, ...args) {
  return nativeFs.readFileSync(assertExisting(file, 'readFileSync'), ...args);
}

export function writeFileSync(file, data, ...args) {
  return nativeFs.writeFileSync(assertWritable(file, 'writeFileSync'), data, ...args);
}

export function mkdirSync(file, ...args) {
  return nativeFs.mkdirSync(assertWritable(file, 'mkdirSync'), ...args);
}

export function renameSync(from, to) {
  return nativeFs.renameSync(assertExisting(from, 'renameSync(source)'), assertWritable(to, 'renameSync(destination)'));
}

export function rmSync(file, ...args) {
  const resolved = assertLexical(file, 'rmSync');
  if (!nativeFs.existsSync(resolved)) return nativeFs.rmSync(resolved, ...args);
  return nativeFs.rmSync(assertExisting(resolved, 'rmSync'), ...args);
}

export function existsSync(file) {
  const resolved = assertLexical(file, 'existsSync');
  if (!nativeFs.existsSync(resolved)) return false;
  assertExisting(resolved, 'existsSync');
  return true;
}

export function realpathSync(file, ...args) {
  const resolved = assertExisting(file, 'realpathSync');
  return nativeFs.realpathSync(resolved, ...args);
}

export function statSync(file, ...args) {
  return nativeFs.statSync(assertExisting(file, 'statSync'), ...args);
}

export function lstatSync(file, ...args) {
  return nativeFs.lstatSync(assertLexical(file, 'lstatSync'), ...args);
}

export function readdirSync(file, ...args) {
  return nativeFs.readdirSync(assertExisting(file, 'readdirSync'), ...args);
}
