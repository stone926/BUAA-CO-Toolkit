import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { planInternalExceptionVictim } from '../../courseTesting/builtinAsm/p7/probeVictims';
import { probeVariantsFor } from '../../courseTesting/builtinAsm/p7/probeVariants';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { Random, hashSeed } from '../../courseTesting/random';
import { p7UserTextBaseAddress } from '../../courseTesting/p7Hardware';
import { parseSimOutput } from '../../language/verilog/traceParser';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { courseInstructionImageHexText } from '../../mips/core/assembler/artifacts';
import { createLegacyProgramImage } from '../../mips/replay/programImage';
import { CourseTimerDevice, TimerState } from '../../mips/core/devices/timer';
import { executeProgramForService } from '../../mips/core/machine/executeService';

// Keep the expected address matrix independent of the generator's variant catalogue.
const timerPorts = [
  { timer: 0, register: 'ctrl', address: 0x7f00 },
  { timer: 0, register: 'preset', address: 0x7f04 },
  { timer: 0, register: 'count', address: 0x7f08 },
  { timer: 1, register: 'ctrl', address: 0x7f10 },
  { timer: 1, register: 'preset', address: 0x7f14 },
  { timer: 1, register: 'count', address: 0x7f18 }
] as const;
const loadCases = timerPorts.flatMap((port) => (['byte', 'half'] as const).map((width) => ({
  ...port,
  width,
  mnemonic: width === 'byte' ? 'lb' : 'lh',
  variant: port.timer === 0 && port.register === 'ctrl'
    ? `timer-${width}-load`
    : `timer${port.timer}-${port.register}-${width}-load`
})));
const countStoreCases = ([0, 1] as const).flatMap((timer) => (['byte', 'half', 'word'] as const).map((width) => ({
  timer,
  width,
  address: timer === 0 ? 0x7f08 : 0x7f18,
  mnemonic: width === 'byte' ? 'sb' : width === 'half' ? 'sh' : 'sw',
  variant: `timer${timer}-count-${width === 'word' ? '' : `${width}-`}store`
})));

describe('P7 Timer MMIO exception probes', () => {
  it('executes all twelve aligned byte/half reads as precise AdEL exceptions', () => {
    const { generated, trace, checked } = executeExceptionProbe('adel');
    for (const testCase of loadCases) {
      const scenario = generated.probe!.scenarios.find((item) => item.variant === testCase.variant);
      expect(scenario, testCase.variant).toBeDefined();
      expect(scenario).toMatchObject({
        expectedExcCode: 4,
        expectedBd: false,
        allowedEpc: [scenario!.victimPc],
        requireCompletion: true
      });
      expect(scenarioBlock(generated.text, scenario!.id)).toMatch(new RegExp(
        `${testCase.mnemonic} \\$\\d+, 0x${testCase.address.toString(16)}\\(\\$0\\)`
      ));
      expect(checked.records.find((record) => record.scenarioId === scenario!.id)?.cause).toBe(4 << 2);

      // Even a zero-valued erroneous load is observable through the victim's GRF commit.
      const wrongCommit = `0@${hex8(scenario!.victimPc!)}: $2 <= 00000000\n${trace}`;
      const rejected = checkP7Probe(wrongCommit, parseSimOutput(wrongCommit), generated.probe!);
      expect(rejected.failures.some((failure) =>
        failure.scenarioId === scenario!.id && failure.message.includes('不应提交，但已写入 GPR'))).toBe(true);
    }
  });

  it('executes both timers Count sb/sh/sw probes and rejects device and DM side effects', () => {
    const { generated, trace, checked } = executeExceptionProbe('ades');
    for (const testCase of countStoreCases) {
      const scenario = generated.probe!.scenarios.find((item) => item.variant === testCase.variant);
      expect(scenario, testCase.variant).toBeDefined();
      expect(scenario).toMatchObject({
        expectedExcCode: 5,
        expectedBd: false,
        allowedEpc: [scenario!.victimPc],
        requireCompletion: true,
        expectedRecords: [{
          expectedExcCode: 5,
          requireEqualAuxPair: true,
          auxPairDescription: `Timer${testCase.timer} 非法存储前后的 COUNT`
        }]
      });
      expect(scenarioBlock(generated.text, scenario!.id)).toContain(
        `${testCase.mnemonic} $20, 0x${testCase.address.toString(16)}($0)`
      );
      const record = checked.records.find((item) => item.scenarioId === scenario!.id)!;
      expect(record.aux1).toBe(record.aux0);

      // MMIO writes are not necessarily part of the architectural DM trace. The
      // handler's legal lw must independently catch a store that corrupts COUNT.
      const aux1Address = generated.probe!.logBase + record.index * generated.probe!.recordWords * 4 + 28;
      const damagedCount = trace.replace(
        new RegExp(`(\\*${hex8(aux1Address)} <= )${hex8(record.aux1)}`, 'i'),
        `$1${hex8(record.aux0 ^ 0xe6)}`
      );
      expect(damagedCount).not.toBe(trace);
      const damaged = checkP7Probe(damagedCount, parseSimOutput(damagedCount), generated.probe!);
      expect(damaged.failures.some((failure) => failure.scenarioId === scenario!.id
        && failure.message.includes('COUNT') && failure.message.includes('在异常前后发生变化'))).toBe(true);

      const leakedWrite = `0@${hex8(scenario!.victimPc!)}: *00000000 <= 2468ace6\n${trace}`;
      const leaked = checkP7Probe(leakedWrite, parseSimOutput(leakedWrite), generated.probe!);
      expect(leaked.failures.some((failure) =>
        failure.scenarioId === scenario!.id && failure.message.includes('不应提交，但已写入 DM'))).toBe(true);

      const wrongPort = `${trace}\nCO_P7_PROBE mmio_on_dm pc=${hex8(scenario!.victimPc!)} addr=${hex8(testCase.address)} byteen=1 time=100`;
      expect(checkP7Probe(wrongPort, parseSimOutput(wrongPort), generated.probe!).failures
        .some((failure) => failure.kind === 'tb' && failure.message.includes('mmio_on_dm'))).toBe(true);
    }
  });

  it('rejects the wrong auxiliary handler stores even when both Timer samples match', () => {
    const { generated, trace, checked, image } = executeExceptionProbe('ades');
    const probe = generated.probe!;
    const scenario = probe.scenarios.find(item => item.variant === 'timer0-ctrl-byte-store')!;
    const record = checked.records.find(item => item.scenarioId === scenario.id)!;
    expect([record.aux0, record.aux1]).toEqual([0, 0]);
    const first = probe.logBase + record.index * probe.recordWords * 4 + 24;
    const legacy = createLegacyProgramImage(courseInstructionImageHexText(image), []);
    for (const code of [image, legacy]) {
      expect(checkP7Probe(trace, parseSimOutput(trace), probe, code).failures).toEqual([]);
      for (const [label, distance] of [['_co_probe_internal_aux_zero', 4], ['_co_probe_internal_aux_timer1_ctrl', 8]] as const) {
        const differentPathPc = image.symbols.find(symbol => symbol.name === label)!.value!;
        const corrupted = parseSimOutput(trace).map(event => {
          if (event.kind !== 'dm') return event;
          const address = Number.parseInt(event.target, 16);
          if (address === first) return { ...event, pc: hex8(differentPathPc) };
          if (address === first + 4) return { ...event, pc: hex8(differentPathPc + distance) };
          return event;
        });
        expect(checkP7Probe(trace, corrupted, probe, code).failures).toContainEqual(expect.objectContaining({
          scenarioId: scenario.id, observed: true, message: expect.stringContaining('辅助字段来自错误')
        }));
      }
    }
  });

  it.each(countStoreCases)('stabilizes $variant from every official timer state before reading Count', (testCase) => {
    const plan = planInternalExceptionVictim('ades', testCase.variant, new Random(hashSeed(testCase.variant)), 'done');
    const stopIndex = plan.instructions.indexOf(`sw $0, 0x${(testCase.address - 8).toString(16)}($0)`);
    const readIndex = plan.instructions.indexOf(`lw $21, 0x${testCase.address.toString(16)}($0)`);
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(stopIndex);
    const observedStates = new Set<TimerState>();
    // PRESET=3 reaches all four states, including LOAD where clearing CTRL alone
    // still permits a subsequent COUNT reload before the timer becomes idle.
    for (let elapsed = 0; elapsed < 8; elapsed++) {
      const timer = new CourseTimerDevice(testCase.timer === 0 ? 'timer0' : 'timer1');
      timer.write(1, 3);
      timer.tick();
      timer.write(0, 3);
      timer.tick();
      for (let cycle = 0; cycle < elapsed; cycle++) timer.tick();
      observedStates.add(timer.snapshot().state);
      timer.write(0, 0);
      timer.tick();
      // One edge per intervening instruction is the fastest possible CPU here;
      // additional stall cycles cannot re-enable a stopped timer.
      for (let cycle = stopIndex + 1; cycle < readIndex; cycle++) timer.tick();
      const before = timer.read(2);
      expect(timer.snapshot().state).toBe('idle');
      for (let cycle = 0; cycle < 100; cycle++) timer.tick();
      expect(timer.read(2)).toBe(before);
      expect(timer.irq).toBe(false);
    }
    expect(observedStates).toEqual(new Set(['idle', 'load', 'cnt', 'int']));
  });
});

function executeExceptionProbe(kind: 'adel' | 'ades') {
  const generated = generateBuiltinAsmTestCase({
    profile: 'P7',
    instructionText: '',
    instructionCount: 1118,
    seed: `p7-mmio-${kind}`,
    interrupt: false,
    timerInterrupt: false,
    exceptionTypes: [kind === 'adel' ? 'AdEL' : 'AdES'],
    p7StressMode: 'probe',
    probeScenarioCount: probeVariantsFor(kind).length
  });
  const assembled = assembleCourseSource({ id: 'mmio-probe', text: generated.text }, { profile: 'P7' });
  expect(assembled.ok, assembled.diagnostics.map((item) => item.message).join('\n')).toBe(true);
  const deviceTimeline = Array.from({ length: 5_000 }, (_, afterInstruction) => ({ afterInstruction, cycles: 1 }));
  const executed = executeProgramForService({
    profile: 'P7',
    segments: assembled.image!.segments,
    entryPc: assembled.image!.entryPc,
    haltPc: p7UserTextBaseAddress + (generated.instructionCount - 2) * 4,
    maxSteps: deviceTimeline.length,
    enabledLayers: ['required', 'commonExtensions', 'marsCompatibility'],
    deviceSchedule: { kind: 'timeline', entries: deviceTimeline },
    collectTrace: true
  });
  expect(executed).toMatchObject({ status: 'halted', haltReason: 'course-halt-loop' });
  const trace = (executed.trace ?? []).join('\n');
  const checked = checkP7Probe(trace, parseSimOutput(trace), generated.probe!, assembled.image);
  expect(checked.failures).toEqual([]);
  return { generated, trace, checked, image: assembled.image! };
}

function scenarioBlock(text: string, id: number): string {
  const start = text.indexOf(`# probe scenario ${id}:`);
  const end = text.indexOf('# probe scenario ', start + 1);
  return text.slice(start, end < 0 ? text.indexOf('.ktext', start) : end);
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}
