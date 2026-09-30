import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ profile: 'P2', memory: 'Default', delayed: false, extra: [] as string[] }));
vi.mock('../../config', () => ({
  getProfile: () => config.profile,
  getMemoryConfiguration: () => config.memory,
  useDelayedBranching: () => config.delayed,
  getMipsExtraArgs: () => config.extra
}));
vi.mock('../../fsUtil', () => ({ readTextFile: vi.fn() }));
import { buildMarsArgs, marsInclusiveDumpRange, officialMarsUnsupportedReason } from '../../language/mips/marsArgs';

const source = { fsPath: 'E:/中文 空格/程序.asm' };
const jar = 'D:/Program Files/Mars/Mars4_5.jar';

describe('official MARS arguments', () => {
  beforeEach(() => Object.assign(config, { profile: 'P2', memory: 'Default', delayed: false, extra: [] }));

  it('uses the official jar launch and explicit nonzero error exits', () => {
    expect(buildMarsArgs(source, jar, 'run')).toEqual([
      '-jar', jar, 'nc', 'mc', 'Default', 'me', 'ae1', 'se1', source.fsPath
    ]);
  });

  it('keeps file paths intact and supports ordinary delayed branching and display options', () => {
    config.profile = 'P6';
    config.delayed = true;
    config.extra = ['me', 'dec', '$t0', 'ae0', 'se0'];
    const args = buildMarsArgs(source, jar, 'run', { stdin: '7\n' });
    expect(args).toEqual(['-jar', jar, 'nc', 'mc', 'Default', 'db', ...config.extra, 'me', 'ae1', 'se1', source.fsPath]);
  });

  it.each(['Default', 'CompactDataAtZero', 'CompactTextAtZero'])('supports original memory configuration %s', (memory) => {
    config.memory = memory;
    expect(buildMarsArgs(source, jar, 'dumpText')).toEqual(['-jar', jar, 'nc', 'mc', memory, 'me', 'ae1', 'se1']);
  });

  it.each(['FixedCompactLargeText', 'CompactLargeText', 'coZeroGpr', 'coStrictData', 'coHalt=0x3010', 'coKernel=0x4180', 'coERR', 'ig', 'cc', 'ccw'])('rejects fork memory configuration %s', (memory) => {
    config.memory = memory;
    expect(() => buildMarsArgs(source, jar, 'run')).toThrow(/builtin/);
  });

  it.each([1, 31, 32, 256])('passes an unambiguous ordinary instruction bound for %s', (maxSteps) => {
    expect(buildMarsArgs(source, jar, 'run', { maxSteps })).toContain(String(Math.max(32, maxSteps)));
  });

  it('consumes resolved values without re-reading mutable settings', () => {
    config.memory = 'CompactLargeText';
    config.extra = ['coL2'];
    expect(buildMarsArgs(source, jar, 'run', {}, 'Default', {
      profile: 'P2', delayedBranching: false, extraArgs: ['me']
    })).toEqual(['-jar', jar, 'nc', 'mc', 'Default', 'me', 'me', 'ae1', 'se1', source.fsPath]);
  });

  it.each([
    { courseTrace: true }, { traceOutput: true }, { p7RiInstruction: true },
    { p7InstructionClassDir: 'custom' }, { interruptSchedule: [0x3010] }
  ])('rejects unsupported course options %o', (options) => {
    expect(() => buildMarsArgs(source, jar, 'run', options)).toThrow(/builtin/);
  });

  it.each(['coL1', 'CoL2', 'efc', 'p7irq=0x3010', 'cl', '-cp', 'custom.class', 'CompactLargeText', 'coZeroGpr', 'coStrictData', 'coHalt=0x3010', 'coKernel=0x4180', 'coERR', 'ig', 'cc', 'ccw'])(
    'rejects fork argument %s', (argument) => {
      config.extra = [argument];
      expect(() => buildMarsArgs(source, jar, 'run')).toThrow(/builtin/);
    }
  );

  it('converts inclusive address endpoints to the exclusive upper boundary used by official dump', () => {
    expect(marsInclusiveDumpRange(0x00400000, 0x00400018)).toBe('0x00400000-0x0040001c');
    expect(marsInclusiveDumpRange(0x00400000, 0x00400000)).toBe('0x00400000-0x00400004');
    expect(() => marsInclusiveDumpRange(0, 0xfffffffc)).toThrow();
    expect(() => marsInclusiveDumpRange(1, 8)).toThrow();
  });

  it('rejects P7 and kernel dump before creating any command', () => {
    expect(officialMarsUnsupportedReason('dumpKernel', {})).toMatch(/builtin/);
    config.profile = 'P7';
    expect(() => buildMarsArgs(source, jar, 'run')).toThrow(/P7/);
  });
});
