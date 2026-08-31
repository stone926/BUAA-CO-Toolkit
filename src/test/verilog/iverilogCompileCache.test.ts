import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RunResult } from '../../types';
import {
  clearIverilogCompileCache,
  IverilogCompileCacheInput,
  lookupIverilogCompileCache,
  maximumIverilogCompileCacheWorkspaces,
  prepareIverilogCompileCacheMiss,
  readIverilogDependencyFile,
  storeIverilogCompileCache
} from '../../verilog/iverilogCompileCache';

interface CacheFixture {
  root: string;
  source: string;
  watchdog: string;
  dependency: string;
  earlierIncludeDirectory: string;
  compiled: string;
  code: string;
  input: IverilogCompileCacheInput;
}

const temporaryRoots: string[] = [];

describe('Icarus session compile cache', () => {
  beforeEach(() => clearIverilogCompileCache());

  afterEach(async () => {
    clearIverilogCompileCache();
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      fs.promises.rm(root, { recursive: true, force: true })
    ));
  });

  it('hits for identical inputs and ignores runtime-only code.txt changes', async () => {
    const fixture = await createFixture();
    await compileAndStore(fixture);

    await fs.promises.writeFile(fixture.code, 'case two machine code\n');
    const lookup = await lookupIverilogCompileCache(fixture.input);

    expect(lookup.hit?.compileResult).toMatchObject({ ok: true, stdout: '', stderr: '' });
  });

  it('stops an aborted lookup without evicting an already valid entry', async () => {
    const fixture = await createFixture();
    await compileAndStore(fixture);
    const controller = new AbortController();
    controller.abort();

    await expect(lookupIverilogCompileCache(fixture.input, controller.signal))
      .resolves.toEqual({});
    expect((await lookupIverilogCompileCache(fixture.input)).hit).toBeDefined();
  });

  it('misses when a direct source is rewritten with the same byte length', async () => {
    const fixture = await createFixture();
    await compileAndStore(fixture);

    const originalBytes = (await fs.promises.stat(fixture.source)).size;
    await fs.promises.writeFile(
      fixture.source,
      '`include "constants.vh"\nmodule cpu; wire b; endmodule\n'
    );
    expect((await fs.promises.stat(fixture.source)).size).toBe(originalBytes);
    const lookup = await lookupIverilogCompileCache(fixture.input);

    expect(lookup.hit).toBeUndefined();
    expect(lookup.snapshot).toBeDefined();
  });

  it.each(['rewrite', 'delete'] as const)('misses when a transitive dependency is %s', async (operation) => {
    const fixture = await createFixture();
    await compileAndStore(fixture);

    if (operation === 'rewrite') {
      await fs.promises.writeFile(fixture.dependency, '`define VALUE 2\n');
    } else {
      await fs.promises.rm(fixture.dependency);
    }
    const lookup = await lookupIverilogCompileCache(fixture.input);

    expect(lookup.hit).toBeUndefined();
  });

  it('misses when a new file in an earlier include directory shadows the recorded dependency', async () => {
    const fixture = await createFixture();
    await compileAndStore(fixture);

    await fs.promises.writeFile(
      path.join(fixture.earlierIncludeDirectory, 'constants.vh'),
      '`define VALUE 9\n'
    );

    expect((await lookupIverilogCompileCache(fixture.input)).hit).toBeUndefined();
  });

  it('fails open instead of caching a dynamic macro include', async () => {
    const fixture = await createFixture();
    await fs.promises.writeFile(fixture.source, [
      '`define HEADER "constants.vh"',
      '`include `HEADER',
      'module cpu; wire a; endmodule',
      ''
    ].join('\n'));
    const lookup = await lookupIverilogCompileCache(fixture.input);
    expect(lookup.snapshot).toBeDefined();
    await prepareIverilogCompileCacheMiss(fixture.input);
    await writeCompilerOutputs(fixture);

    expect(await storeIverilogCompileCache(
      lookup.snapshot!,
      successfulCompileResult()
    )).toBe(false);
    expect((await lookupIverilogCompileCache(fixture.input)).hit).toBeUndefined();
  });

  it.each(['tamper', 'replace-identically', 'delete'] as const)(
    'misses when the compiled artifact is %s',
    async (operation) => {
      const fixture = await createFixture();
      await compileAndStore(fixture);

      if (operation === 'tamper') {
        await fs.promises.writeFile(fixture.compiled, 'tampered artifact');
      } else if (operation === 'replace-identically') {
        await fs.promises.rm(fixture.compiled);
        await fs.promises.writeFile(fixture.compiled, 'compiled artifact');
        const replacementTime = new Date('2000-01-01T00:00:00.000Z');
        await fs.promises.utimes(fixture.compiled, replacementTime, replacementTime);
      } else {
        await fs.promises.rm(fixture.compiled);
      }
      const lookup = await lookupIverilogCompileCache(fixture.input);

      expect(lookup.hit).toBeUndefined();
    }
  );

  it('does not cache a failed compile even if partial outputs exist', async () => {
    const fixture = await createFixture();
    const lookup = await lookupIverilogCompileCache(fixture.input);
    expect(lookup.snapshot).toBeDefined();
    await prepareIverilogCompileCacheMiss(fixture.input);
    await writeCompilerOutputs(fixture);

    const stored = await storeIverilogCompileCache(
      lookup.snapshot!,
      successfulCompileResult({ ok: false, exitCode: 1, stderr: 'syntax error' })
    );

    expect(stored).toBe(false);
    expect((await lookupIverilogCompileCache(fixture.input)).hit).toBeUndefined();
  });

  it('does not publish a successful compile after cache publication is cancelled', async () => {
    const fixture = await createFixture();
    const lookup = await lookupIverilogCompileCache(fixture.input);
    await prepareIverilogCompileCacheMiss(fixture.input);
    await writeCompilerOutputs(fixture);
    const controller = new AbortController();
    controller.abort();

    await expect(storeIverilogCompileCache(
      lookup.snapshot!,
      successfulCompileResult(),
      controller.signal
    )).resolves.toBe(false);
    expect((await lookupIverilogCompileCache(fixture.input)).hit).toBeUndefined();
  });

  it('fails open when the include-directory safety bound is exceeded', async () => {
    const fixture = await createFixture();
    const overflowArguments = [...fixture.input.compileArguments];
    for (let index = 0; index < 257; index++) {
      overflowArguments.push('-I', path.join(fixture.root, `include-${index}`));
    }
    const input = { ...fixture.input, compileArguments: overflowArguments };
    const lookup = await lookupIverilogCompileCache(input);
    expect(lookup.snapshot).toBeDefined();
    await prepareIverilogCompileCacheMiss(input);
    await writeCompilerOutputs(fixture);

    expect(await storeIverilogCompileCache(
      lookup.snapshot!,
      successfulCompileResult()
    )).toBe(false);
    expect((await lookupIverilogCompileCache(input)).hit).toBeUndefined();
  });

  it('changes the key when runtime version or exact compiler argv changes', async () => {
    const fixture = await createFixture();
    await compileAndStore(fixture);

    expect((await lookupIverilogCompileCache({
      ...fixture.input,
      runtime: { ...fixture.input.runtime, version: 'Icarus Verilog 14.0' }
    })).hit).toBeUndefined();

    await compileAndStore(fixture);
    expect((await lookupIverilogCompileCache({
      ...fixture.input,
      compileArguments: [...fixture.input.compileArguments, '-DCHANGED=1']
    })).hit).toBeUndefined();
  });

  it('parses absolute dependency paths containing spaces and non-ASCII characters', async () => {
    const fixture = await createFixture();
    const dependencyFile = path.join(fixture.root, '依赖 closure.txt');
    await fs.promises.writeFile(dependencyFile, `${fixture.source}\r\n${fixture.dependency}\r\n`);

    await expect(readIverilogDependencyFile(dependencyFile, fixture.root)).resolves.toEqual([
      path.normalize(fixture.source),
      path.normalize(fixture.dependency)
    ]);
  });

  it('fails open for dependency paths that collide only after Windows case folding', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-iverilog-cache-collision-'));
    temporaryRoots.push(root);
    const dependencyFile = path.join(root, 'case-collision.dependencies');
    await fs.promises.writeFile(
      dependencyFile,
      ['E:\\CaseSensitive\\Foo.v', 'E:\\CaseSensitive\\foo.v', ''].join('\n')
    );

    await expect(readIverilogDependencyFile(dependencyFile, root))
      .rejects.toThrow(/collide after Windows normalization/);
  });

  it('keeps a bounded LRU across workspaces', async () => {
    const fixtures = await Promise.all(Array.from(
      { length: maximumIverilogCompileCacheWorkspaces + 1 },
      async () => await createFixture()
    ));
    for (const fixture of fixtures.slice(0, maximumIverilogCompileCacheWorkspaces)) {
      await compileAndStore(fixture);
    }

    // Touch the oldest entry, then insert one more workspace. The second-oldest
    // entry should be evicted while the touched entry stays hot.
    expect((await lookupIverilogCompileCache(fixtures[0].input)).hit).toBeDefined();
    await compileAndStore(fixtures.at(-1)!);

    expect((await lookupIverilogCompileCache(fixtures[0].input)).hit).toBeDefined();
    expect((await lookupIverilogCompileCache(fixtures[1].input)).hit).toBeUndefined();
    expect((await lookupIverilogCompileCache(fixtures.at(-1)!.input)).hit).toBeDefined();
  });
});

async function createFixture(): Promise<CacheFixture> {
  const temporaryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-iverilog-cache-'));
  temporaryRoots.push(temporaryRoot);
  const root = path.join(temporaryRoot, '课程 workspace with spaces');
  const sourceDir = path.join(root, 'src');
  const earlierIncludeDirectory = path.join(root, 'include-early');
  const dependencyDirectory = path.join(root, 'include-late');
  const outDir = path.join(root, '.co', 'isim');
  await Promise.all([
    fs.promises.mkdir(sourceDir, { recursive: true }),
    fs.promises.mkdir(earlierIncludeDirectory, { recursive: true }),
    fs.promises.mkdir(dependencyDirectory, { recursive: true }),
    fs.promises.mkdir(outDir, { recursive: true })
  ]);
  const source = path.join(sourceDir, 'cpu.v');
  const watchdog = path.join(outDir, 'co_iverilog_watchdog.v');
  const dependency = path.join(dependencyDirectory, 'constants.vh');
  const compiled = path.join(outDir, 'simulation.vvp');
  const dependencyFile = path.join(outDir, 'simulation.dependencies');
  const code = path.join(outDir, 'code.txt');
  await Promise.all([
    fs.promises.writeFile(source, '`include "constants.vh"\nmodule cpu; wire a; endmodule\n'),
    fs.promises.writeFile(watchdog, 'module __watchdog; endmodule\n'),
    fs.promises.writeFile(dependency, '`define VALUE 1\n'),
    fs.promises.writeFile(code, 'case one machine code\n')
  ]);
  const compileArguments = [
    '-g2005',
    '-grelative-include',
    '-I', earlierIncludeDirectory,
    '-I', dependencyDirectory,
    '-I', root,
    `-Mall=${dependencyFile}`,
    '-t', 'vvp',
    '-s', 'cpu_tb',
    '-s', '__watchdog',
    '-o', compiled,
    source,
    watchdog
  ];
  return {
    root,
    source,
    watchdog,
    dependency,
    earlierIncludeDirectory,
    compiled,
    code,
    input: {
      workspaceRoot: root,
      compileCwd: outDir,
      runtime: {
        rootDir: 'C:/extension/vendor/iverilog/win32-x64',
        binDir: 'C:/extension/vendor/iverilog/win32-x64/bin',
        libDir: 'C:/extension/vendor/iverilog/win32-x64/lib/ivl',
        iverilogPath: 'C:/extension/vendor/iverilog/win32-x64/bin/iverilog.exe',
        vvpPath: 'C:/extension/vendor/iverilog/win32-x64/bin/vvp.exe',
        version: 'Icarus Verilog 13.0'
      },
      compileArguments,
      directSourceFiles: [source, watchdog],
      compiledFile: compiled,
      dependencyFile
    }
  };
}

async function compileAndStore(fixture: CacheFixture): Promise<void> {
  const lookup = await lookupIverilogCompileCache(fixture.input);
  expect(lookup.hit).toBeUndefined();
  expect(lookup.snapshot).toBeDefined();
  expect(await prepareIverilogCompileCacheMiss(fixture.input)).toBe(true);
  await writeCompilerOutputs(fixture);
  expect(await storeIverilogCompileCache(
    lookup.snapshot!,
    successfulCompileResult()
  )).toBe(true);
}

async function writeCompilerOutputs(fixture: CacheFixture): Promise<void> {
  await Promise.all([
    fs.promises.writeFile(fixture.compiled, 'compiled artifact'),
    fs.promises.writeFile(fixture.input.dependencyFile, [
      fixture.source,
      fixture.watchdog,
      fixture.dependency,
      ''
    ].join('\n'))
  ]);
}

function successfulCompileResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    ok: true,
    exitCode: 0,
    commandLine: 'iverilog',
    cwd: '',
    stdout: 'compiled once',
    stderr: '',
    timedOut: false,
    stopped: false,
    ...overrides
  };
}
