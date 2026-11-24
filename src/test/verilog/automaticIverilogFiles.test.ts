import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';
import { createAutomaticIverilogRunDirectory, discardAutomaticIverilogDependencies } from '../../verilog/automaticIverilogFiles';

it('cleans one automatic run without touching concurrent inputs or a shared VVP build', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'co-iverilog-run-'));
  const [first, second] = await Promise.all([
    createAutomaticIverilogRunDirectory(), createAutomaticIverilogRunDirectory()
  ]);
  try {
    const temporaryRoot = await fs.realpath(os.tmpdir());
    expect(path.dirname(first.directory)).toBe(temporaryRoot);
    expect(path.dirname(second.directory)).toBe(temporaryRoot);
    expect(first.directory).not.toBe(second.directory);
    const buildParent = path.join(workspace, '.co', 'iverilog', 'automatic');
    const buildDir = path.join(buildParent, 'build-0');
    await fs.mkdir(buildDir, { recursive: true });
    const firstCode = path.join(first.directory, 'code.txt');
    const secondCode = path.join(second.directory, 'code.txt');
    const compiled = path.join(buildDir, 'simulation.vvp');
    const dependencies = path.join(buildDir, 'simulation.dependencies');
    await Promise.all([
      fs.writeFile(firstCode, 'first'), fs.writeFile(secondCode, 'second'),
      fs.writeFile(compiled, 'cached'), fs.writeFile(dependencies, 'source.v')
    ]);

    await first.dispose();
    await discardAutomaticIverilogDependencies(workspace, dependencies);
    await expect(fs.stat(first.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(dependencies)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(secondCode, 'utf8')).resolves.toBe('second');
    await expect(fs.readFile(compiled, 'utf8')).resolves.toBe('cached');
    await second.dispose();
    await expect(fs.stat(second.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(buildDir)).toEqual(['simulation.vvp']);
    expect(await fs.readdir(buildParent)).toEqual(['build-0']);
  } finally {
    await Promise.all([first.dispose(), second.dispose()]);
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

it('does not remove a directory that replaced an automatic run', async () => {
  const run = await createAutomaticIverilogRunDirectory();
  const original = `${run.directory}-original`;
  try {
    await fs.rename(run.directory, original);
    await fs.mkdir(run.directory);
    const file = path.join(run.directory, 'keep.txt');
    await fs.writeFile(file, 'keep');

    await run.dispose();

    await expect(fs.readFile(file, 'utf8')).resolves.toBe('keep');
  } finally {
    await Promise.all([run.directory, original].map(directory => fs.rm(directory, { recursive: true, force: true })));
  }
});
