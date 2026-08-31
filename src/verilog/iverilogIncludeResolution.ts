// @index verilog-iverilog-compile-cache — literal include 解析、搜索顺序与 shadow 负依赖验证
import * as fs from 'fs';
import * as path from 'path';
import { normalizePathKey } from '../pathUtils';
import {
  mapWithConcurrency,
  readFileBounded,
  resolveCompilerPath,
  throwIfAborted
} from './iverilogCompileCacheIo';

const fingerprintConcurrency = 8;
const maximumIncludeScanFileBytes = 8 * 1024 * 1024;
const maximumIncludeScanTotalBytes = 64 * 1024 * 1024;
const maximumIncludeDirectories = 256;
const maximumIncludeTokens = 20_000;
const maximumIncludeCandidates = 20_000;
const maximumIncludeTokenLength = 4_096;

export interface IncludePathObservation {
  path: string;
  kind: 'missing' | 'file' | 'other';
}

interface ParsedIncludeDirective {
  includer: string;
  token: string;
}

interface IncludeSearchSettings {
  relativeInclude: boolean;
  directories: readonly string[];
}

export interface IverilogIncludeResolutionInput {
  compileCwd: string;
  compileArguments: readonly string[];
}

export async function buildIverilogIncludeResolutionGuards(
  input: IverilogIncludeResolutionInput,
  dependencyPaths: readonly string[],
  signal?: AbortSignal
): Promise<IncludePathObservation[]> {
  const settings = parseIncludeSearchSettings(input.compileArguments, input.compileCwd);
  const directives = await readLiteralIncludeDirectives(dependencyPaths, signal);
  const dependencyKeys = new Set(dependencyPaths.map((dependency) =>
    normalizePathKey(resolveCompilerPath(dependency, input.compileCwd))
  ));
  const observationsByPath = new Map<string, IncludePathObservation>();

  for (const directive of directives) {
    throwIfAborted(signal);
    const searchDirectories = dedupeNormalizedPaths([
      ...(settings.relativeInclude ? [path.dirname(directive.includer)] : []),
      input.compileCwd,
      ...settings.directories
    ]);
    if (searchDirectories.length > maximumIncludeDirectories) {
      throw new Error(`Icarus include search exceeds ${maximumIncludeDirectories} directories`);
    }

    const candidatePaths = path.isAbsolute(directive.token)
      ? [path.normalize(directive.token)]
      : searchDirectories.map((directory) => path.resolve(directory, directive.token));
    const uniqueCandidates = dedupeNormalizedPaths(candidatePaths);
    const directiveObservations: IncludePathObservation[] = [];
    let resolved = false;
    for (const candidate of uniqueCandidates) {
      throwIfAborted(signal);
      const observation = await observeIncludePath(candidate);
      directiveObservations.push(observation);
      if (observation.kind !== 'file') continue;
      if (!dependencyKeys.has(normalizePathKey(candidate))) {
        // This is commonly inactive preprocessor text. Without duplicating
        // ivlpp its active state cannot be established safely.
        throw new Error(`Icarus include resolution is ambiguous: ${directive.token}`);
      }
      resolved = true;
      break;
    }

    if (!resolved) {
      // Standard-library includes may resolve outside the explicit search list.
      // Hash the positive dependency and guard each earlier known candidate.
      const matches = dependencyPaths.filter((dependency) =>
        dependencyPathMatchesIncludeToken(dependency, directive.token)
      );
      if (matches.length !== 1
        || directiveObservations.some((observation) => observation.kind === 'other')) {
        throw new Error(`Icarus include token cannot be resolved reliably: ${directive.token}`);
      }
    }

    for (const observation of directiveObservations) {
      const key = normalizePathKey(observation.path);
      const existing = observationsByPath.get(key);
      if (existing && existing.kind !== observation.kind) {
        throw new Error(`Icarus include candidate changed while observing: ${observation.path}`);
      }
      observationsByPath.set(key, observation);
      if (observationsByPath.size > maximumIncludeCandidates) {
        throw new Error(`Icarus include resolution exceeds ${maximumIncludeCandidates} candidates`);
      }
    }
  }

  return [...observationsByPath.values()];
}

export async function validateIverilogIncludeResolutionGuards(
  expected: readonly IncludePathObservation[],
  signal?: AbortSignal
): Promise<boolean> {
  const current = await mapWithConcurrency(
    expected,
    fingerprintConcurrency,
    async (observation) => await observeIncludePath(observation.path),
    signal
  );
  return current.length === expected.length
    && current.every((observation, index) =>
      normalizePathKey(observation.path) === normalizePathKey(expected[index].path)
      && observation.kind === expected[index].kind
    );
}

function parseIncludeSearchSettings(
  compileArguments: readonly string[],
  compileCwd: string
): IncludeSearchSettings {
  let relativeInclude = false;
  const directories: string[] = [];
  for (let index = 0; index < compileArguments.length; index++) {
    const argument = compileArguments[index];
    if (argument === '-grelative-include') {
      relativeInclude = true;
      continue;
    }
    if (argument === '-gno-relative-include') {
      relativeInclude = false;
      continue;
    }
    if (argument === '-I') {
      const directory = compileArguments[++index];
      if (!directory?.trim()) {
        throw new Error('Icarus compile arguments contain an incomplete -I option');
      }
      directories.push(resolveCompilerPath(directory, compileCwd));
      continue;
    }
    if (argument.startsWith('-I') && argument.length > 2) {
      directories.push(resolveCompilerPath(argument.slice(2), compileCwd));
      continue;
    }
    if (argument.startsWith('+incdir+')) {
      const paths = argument.slice('+incdir+'.length).split('+').filter(Boolean);
      directories.push(...paths.map((directory) => resolveCompilerPath(directory, compileCwd)));
    }
  }
  const uniqueDirectories = dedupeNormalizedPaths(directories);
  if (uniqueDirectories.length > maximumIncludeDirectories) {
    throw new Error(`Icarus include search exceeds ${maximumIncludeDirectories} directories`);
  }
  return { relativeInclude, directories: uniqueDirectories };
}

async function readLiteralIncludeDirectives(
  dependencyPaths: readonly string[],
  signal?: AbortSignal
): Promise<ParsedIncludeDirective[]> {
  const directives: ParsedIncludeDirective[] = [];
  let totalBytes = 0;
  for (const dependency of dependencyPaths) {
    throwIfAborted(signal);
    const bytes = await readFileBounded(
      dependency,
      maximumIncludeScanFileBytes,
      'Icarus dependency source',
      signal
    );
    totalBytes += bytes.byteLength;
    if (totalBytes > maximumIncludeScanTotalBytes) {
      throw new Error(`Icarus include scan exceeds ${maximumIncludeScanTotalBytes} bytes`);
    }
    directives.push(...parseLiteralIncludeDirectives(
      bytes.toString('utf8'),
      resolveCompilerPath(dependency, process.cwd())
    ));
    if (directives.length > maximumIncludeTokens) {
      throw new Error(`Icarus include scan exceeds ${maximumIncludeTokens} directives`);
    }
  }
  return directives;
}

function parseLiteralIncludeDirectives(text: string, includer: string): ParsedIncludeDirective[] {
  const directives: ParsedIncludeDirective[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === '/' && text[index + 1] === '/') {
      index = skipLineComment(text, index + 2);
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      index = skipBlockComment(text, index + 2);
      continue;
    }
    if (text[index] === '"') {
      index = skipQuotedText(text, index + 1);
      continue;
    }
    if (text[index] !== '`') {
      index++;
      continue;
    }

    let cursor = index + 1;
    const nameStart = cursor;
    while (cursor < text.length && /[A-Za-z0-9_$]/.test(text[cursor])) cursor++;
    if (text.slice(nameStart, cursor) !== 'include') {
      index = Math.max(cursor, index + 1);
      continue;
    }
    while (cursor < text.length && /[ \t\f\v]/.test(text[cursor])) cursor++;
    if (text[cursor] !== '"') {
      throw new Error('Dynamic Icarus `include cannot be validated safely');
    }
    cursor++;
    const tokenStart = cursor;
    while (cursor < text.length && text[cursor] !== '"') {
      if (text[cursor] === '\r' || text[cursor] === '\n' || text[cursor] === '\0'
        || text[cursor] === '`') {
        throw new Error('Dynamic or malformed Icarus `include cannot be validated safely');
      }
      cursor++;
    }
    if (cursor >= text.length) {
      throw new Error('Unterminated Icarus `include cannot be validated safely');
    }
    const token = text.slice(tokenStart, cursor);
    if (!token || token.length > maximumIncludeTokenLength) {
      throw new Error('Icarus `include token is empty or too long');
    }
    directives.push({ includer, token });
    index = cursor + 1;
  }
  return directives;
}

function skipLineComment(text: string, index: number): number {
  while (index < text.length && text[index] !== '\n') index++;
  return index;
}

function skipBlockComment(text: string, index: number): number {
  while (index < text.length) {
    if (text[index] === '*' && text[index + 1] === '/') return index + 2;
    index++;
  }
  return index;
}

function skipQuotedText(text: string, index: number): number {
  let escaped = false;
  while (index < text.length) {
    const character = text[index++];
    if (character === '"' && !escaped) break;
    escaped = character === '\\' && !escaped;
    if (character !== '\\') escaped = false;
  }
  return index;
}

async function observeIncludePath(file: string): Promise<IncludePathObservation> {
  const absolute = path.resolve(file);
  try {
    const stat = await fs.promises.stat(absolute);
    return { path: absolute, kind: stat.isFile() ? 'file' : 'other' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { path: absolute, kind: 'missing' };
    }
    throw error;
  }
}

function dependencyPathMatchesIncludeToken(dependency: string, token: string): boolean {
  const dependencyKey = normalizePathKey(path.resolve(dependency));
  if (path.isAbsolute(token)) {
    return dependencyKey === normalizePathKey(path.normalize(token));
  }
  const tokenKey = normalizePathKey(path.normalize(token)).replace(/^\.\//, '');
  if (!tokenKey || tokenKey === '..' || tokenKey.startsWith('../')) return false;
  return dependencyKey === tokenKey || dependencyKey.endsWith(`/${tokenKey}`);
}

function dedupeNormalizedPaths(files: readonly string[]): string[] {
  const seen = new Map<string, string>();
  const result: string[] = [];
  for (const file of files) {
    const absolute = path.resolve(file);
    const key = normalizePathKey(absolute);
    const previous = seen.get(key);
    if (previous !== undefined && previous !== absolute) {
      throw new Error(`Icarus paths collide after Windows normalization: ${previous} / ${absolute}`);
    }
    if (previous !== undefined) continue;
    seen.set(key, absolute);
    result.push(absolute);
  }
  return result;
}
