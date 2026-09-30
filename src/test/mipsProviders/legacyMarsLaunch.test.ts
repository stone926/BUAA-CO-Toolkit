import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  java: '',
  jar: '',
  memory: 'Default',
  profile: 'P6',
  timeout: 12_345,
  delayed: true,
  extraArgs: [] as string[]
}));

vi.mock('vscode', () => ({ Uri: { file: URI.file } }));
vi.mock('../../config', () => ({
  getJava: vi.fn(() => config.java),
  getMarsJar: vi.fn(() => config.jar),
  getMemoryConfiguration: vi.fn(() => config.memory),
  getProfile: vi.fn(() => config.profile),
  getRunTimeout: vi.fn(() => config.timeout),
  getMipsExtraArgs: vi.fn(() => config.extraArgs),
  useDelayedBranching: vi.fn(() => config.delayed)
}));

import { resolveLegacyMarsLaunch } from '../../mips/providers/legacyMarsLaunch';

describe('official MARS launch preflight', () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-mars-preflight-'));
    source = path.join(root, 'program.asm');
    config.jar = path.join(root, 'Mars.jar');
    config.java = path.join(root, process.platform === 'win32' ? 'java.exe' : 'java');
    config.memory = 'Default';
    config.profile = 'P6';
    config.timeout = 12_345;
    config.delayed = true;
    config.extraArgs = [];
    await Promise.all([
      fs.promises.writeFile(source, '.text\nnop\n'),
      fs.promises.writeFile(config.jar, 'fixture-jar'),
      fs.promises.writeFile(config.java, 'fixture-java')
    ]);
    if (process.platform !== 'win32') await fs.promises.chmod(config.java, 0o755);
  });

  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('returns one immutable snapshot of all launch-affecting settings', async () => {
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {
      stdin: '42\n'
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.launch).toMatchObject({
      profile: 'P6',
      configuredMars: path.resolve(config.jar),
      memoryConfiguration: 'Default',
      wallClockMs: 12_345,
      p7RiInstruction: false
    });

    config.java = path.join(root, 'changed-java');
    config.memory = 'Default';
    config.timeout = 1;
    expect(result.launch).toMatchObject({
      memoryConfiguration: 'Default',
      wallClockMs: 12_345
    });
    expect(result.launch?.runtime.command).not.toBe(config.java);
  });

  it('rejects unsupported course semantics without probing source or artifacts', async () => {
    const open = vi.spyOn(fs.promises, 'open');
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {
      courseTrace: true,
      traceOutput: true
    });
    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain('official-mars.course-semantics-unsupported');
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('reports unreadable artifacts on an ordinary launch', async () => {
    await fs.promises.rm(config.jar);
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {});
    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain('legacy-mars.jar-unreadable');
  });

  it('rejects P7 ordinary execution with a builtin recommendation', async () => {
    config.profile = 'P7';
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {});
    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.some((item) => /P7/.test(item.message) && /builtin|内置/.test(item.message))).toBe(true);
  });

  it.each(['coL2', 'efc', 'cl', 'p7irq=0x3010'])('rejects unsupported configured argument %s', async (arg) => {
    config.extraArgs = [arg];
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {});
    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain('official-mars.course-semantics-unsupported');
  });

  it('rejects an unbounded zero timeout before dispatch', async () => {
    config.timeout = 0;
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {

    });

    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain('legacy-mars.timeout-invalid');
  });
});
