// @index single-generate-native-tests — Real bundled Icarus checks for implicit generate scopes
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildIverilogEnvironment, buildIverilogRuntimeArgs, resolveIverilogRuntime } from '../../../verilog/iverilogRuntime';
import { invalidSingleGenerateCases, validSingleGenerateCases } from '../../helpers/singleItemGenerateCases';

const runtime = resolveIverilogRuntime(path.resolve(__dirname, '../../../..'));
const available = fs.existsSync(runtime.iverilogPath);

describe.skipIf(!available)('single generated items against real bundled Icarus -g2005', () => {
  let directory: string;
  let sequence = 1;
  beforeAll(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co 单项 generate ')); });
  afterAll(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  function compile(source: string) {
    const file = path.join(directory, `${sequence++}.v`);
    fs.writeFileSync(file, source);
    return spawnSync(runtime.iverilogPath, [...buildIverilogRuntimeArgs(runtime), '-g2005', '-tnull', '-i', file], { encoding: 'utf8', timeout: 10000, env: buildIverilogEnvironment(runtime) });
  }
  it.each(invalidSingleGenerateCases)('rejects %s', (_name, marked) => {
    const result = compile(marked.replace('[[', '').replace(']]', ''));
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
  });
  it.each(validSingleGenerateCases)('accepts %s', (source) => {
    const result = compile(source);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
