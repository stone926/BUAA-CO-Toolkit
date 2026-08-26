import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  java: '',
  jar: '',
  memory: 'FixedCompactLargeText',
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

describe('legacy MARS launch preflight', () => {
  let root: string;
  let source: string;

  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-mars-preflight-'));
    source = path.join(root, 'program.asm');
    config.jar = path.join(root, 'Mars.jar');
    config.java = path.join(root, process.platform === 'win32' ? 'java.exe' : 'java');
    config.memory = 'FixedCompactLargeText';
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
      courseTrace: true,
      traceOutput: true,
      maxSteps: 256,
      haltPc: 0x3010
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.launch).toMatchObject({
      profile: 'P6',
      configuredMars: path.resolve(config.jar),
      memoryConfiguration: 'FixedCompactLargeText',
      wallClockMs: 12_345,
      p7RiInstruction: false
    });

    config.java = path.join(root, 'changed-java');
    config.memory = 'Default';
    config.timeout = 1;
    expect(result.launch).toMatchObject({
      memoryConfiguration: 'FixedCompactLargeText',
      wallClockMs: 12_345
    });
    expect(result.launch?.runtime.command).not.toBe(config.java);
  });

  it('fails before dispatch for unreadable artifacts and invalid course limits', async () => {
    await fs.promises.rm(config.jar);
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {
      courseTrace: true,
      traceOutput: true
    });

    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      'legacy-mars.jar-unreadable',
      'legacy-mars.max-steps-required',
      'legacy-mars.halt-pc-required'
    ]));
  });

  it('rejects the wrong P7 memory layout before registry/output writes', async () => {
    config.profile = 'P7';
    config.memory = 'Default';
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'dumpText', {
      courseTrace: true,
      p7RiInstruction: false
    });

    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain('legacy-mars.p7-memory-configuration');
  });

  it('rejects an unbounded zero timeout before dispatch', async () => {
    config.timeout = 0;
    const result = await resolveLegacyMarsLaunch(URI.file(source) as never, 'run', {
      courseTrace: true,
      traceOutput: true,
      maxSteps: 64,
      haltPc: 0x3004
    });

    expect(result.launch).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain('legacy-mars.timeout-invalid');
  });
});
