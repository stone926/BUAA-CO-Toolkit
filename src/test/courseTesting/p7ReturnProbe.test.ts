import { describe, expect, it } from 'vitest';
import { generateBuiltinAsmTestCase } from '../../courseTesting/builtinAsmGenerator';
import { automaticReturnVariants } from '../../courseTesting/builtinAsm/p7/probeReturnProgram';
import { checkP7Probe } from '../../courseTesting/p7ProbeCheck';
import { assembleCourseSource } from '../../mips/core/assembler/assembler';
import { executeProgramForService } from '../../mips/core/machine/executeService';
import { findCourseHaltPc } from '../../mips/core/assembler/artifacts';
import { parseSimOutput } from '../../language/verilog/traceParser';
import type { P7ProbeReturnVariant } from '../../courseTesting/builtinAsm/types';

function run(variant: P7ProbeReturnVariant, second: 'entry' | 'delay' | 'none' = 'entry', seed = 'real-handler-return') {
  const generated = generateBuiltinAsmTestCase({ profile: 'P7', instructionText: '', instructionCount: 1118,
    p7StressMode: 'probe', probeShard: 'return', probeReturnVariant: variant, seed });
  const assembly = assembleCourseSource({ id: 'return', text: generated.text }, { profile: 'P7' });
  expect(assembly.ok, JSON.stringify(assembly.diagnostics)).toBe(true);
  const first = generated.probe!.scenarios[0];
  const executed = executeProgramForService({ profile: 'P7', segments: assembly.image!.segments,
    entryPc: 0x3000, haltPc: findCourseHaltPc(assembly.image!, 'P7'), maxSteps: 4096, collectTrace: true,
    externalInterrupts: [
      { victimPc: first.triggerPc!, occurrence: 1 },
      ...(second === 'none' ? [] : [{ victimPc: second === 'delay' ? first.triggerPc! : first.allowedEpc[0], occurrence: 2 }])
    ] });
  expect(executed.status, JSON.stringify(executed.diagnostic)).toBe('halted');
  const secondPc = (second === 'delay' ? first.triggerPc! : first.allowedEpc[0]).toString(16).padStart(8, '0');
  const eretPc = generated.probe!.scenarios[1].afterReturnOf!.eretPc.toString(16).padStart(8, '0');
  const diagnostics = ['external_arm scenario=1', 'external_raise scenario=1', 'external_ack scenario=1',
    ...(second === 'none' ? [] : [`return_seen scenario=2 pc=${eretPc}`, `return_exit scenario=2 pc=${secondPc}`,
      `external_raise scenario=2 pc=${secondPc}`, 'external_ack scenario=2'])]
    .map(text => `CO_P7_PROBE ${text}`).join('\n');
  return { generated, executed, diagnostics, events: parseSimOutput(executed.trace!.join('\n')) };
}

describe('real handler return boundary probes', () => {
  it.each(automaticReturnVariants)('%s completes two architectural interrupts with exact main effects', variant => {
    const fixture = run(variant);
    const result = checkP7Probe(fixture.diagnostics, fixture.events, fixture.generated.probe!);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.coverage?.[0].covered).toBe(true);
    expect(fixture.generated.instructionCount * 4 + 0x3000).toBeLessThan(0x4180);
    expect(fixture.generated.text).not.toContain('jal _co_probe_priority_release');
  });

  it('allows only jal link replays explained by the observed BD/EPC records', () => {
    const fixture = run('jal-delay', 'delay');
    const metadata = fixture.generated.probe!;
    const link = metadata.returnBoundary!.replayedLink!;
    const commits = fixture.events.filter(event => parseInt(event.pc, 16) === link.pc);
    expect(commits).toHaveLength(3);
    expect(checkP7Probe(fixture.diagnostics, fixture.events, metadata).failures).toEqual([]);
    for (const bad of [fixture.events.filter(event => event !== commits[1]), [...fixture.events, commits[0]]]) {
      expect(checkP7Probe(fixture.diagnostics, bad, metadata).failures.some(f => f.message.includes('jal 链接写入'))).toBe(true);
    }
  });

  it('varies operands and layout while retaining the return/hazard obligations', () => {
    for (const variant of automaticReturnVariants) for (let seed = 0; seed < 8; seed++) {
      const fixture = run(variant, 'entry', `return-layout-${seed}`);
      expect(checkP7Probe(fixture.diagnostics, fixture.events, fixture.generated.probe!).failures).toEqual([]);
    }
  });

  it.each(automaticReturnVariants)('%s reports an unobserved second boundary without inventing a CPU failure', variant => {
    const fixture = run(variant, 'none');
    const checked = checkP7Probe(fixture.diagnostics, fixture.events, fixture.generated.probe!);
    expect(checked.failures).toEqual([]);
    expect(checked.passed).toBe(false);
    expect(checked.coverage?.[0].covered).toBe(false);
  });

  it('rejects lost, duplicated, or wrong main commits even when final values could be repaired', () => {
    const fixture = run('load-jr');
    const metadata = fixture.generated.probe!;
    for (const expected of metadata.returnBoundary!.mainCommits) {
      const original = fixture.events.find(event => parseInt(event.pc, 16) === expected.pc)!;
      for (const bad of [fixture.events.filter(event => event !== original), [...fixture.events, original],
        fixture.events.map(event => event === original ? { ...event, value: 'deadbeef' } : event)]) {
        expect(checkP7Probe(fixture.diagnostics, bad, metadata).passed).toBe(false);
      }
    }
  });

  it('does not downgrade real failures when return observations are absent', () => {
    const fixture = run('direct', 'none');
    const original = fixture.events[0];
    const result = checkP7Probe(fixture.diagnostics, [...fixture.events, original], fixture.generated.probe!);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('recognizes an illegal raw return PC even when the second request did not fire', () => {
    const fixture = run('direct', 'none');
    const metadata = fixture.generated.probe!;
    const eret = metadata.scenarios[1].afterReturnOf!.eretPc.toString(16).padStart(8, '0');
    const seen = `${fixture.diagnostics}\nCO_P7_PROBE return_seen scenario=2 pc=${eret}`;
    expect(checkP7Probe(seen, fixture.events, metadata).failures).toEqual([]);
    for (const pc of ['00003000', '000041c8', '0000304x', '0000304z', '00003045']) {
      const invalid = `${seen}\nCO_P7_PROBE return_exit scenario=2 pc=${pc}`;
      expect(checkP7Probe(invalid, fixture.events, metadata).failures
        .some(failure => failure.observed && failure.message.includes('非法返回地址'))).toBe(true);
    }
  });

  it('binds raw second-request PC to EPC and the actual delay slot, including old TB output', () => {
    const fixture = run('direct');
    const metadata = fixture.generated.probe!;
    const historical = fixture.diagnostics.replace(/(external_raise scenario=2) pc=[0-9a-f]+/, '$1');
    expect(checkP7Probe(historical, fixture.events, metadata).passed).toBe(true);
    const badPc = fixture.diagnostics.replace(/(external_raise scenario=2) pc=[0-9a-f]+/, '$1 pc=00003000');
    expect(checkP7Probe(badPc, fixture.events, metadata).failures
      .some(failure => failure.message.includes('原始宏观 PC'))).toBe(true);
    const cause = metadata.returnBoundary!.handlerCommits.find(commit => commit.kind === 'grf' && commit.value === 'cause')!;
    const causeReads = fixture.events.filter(event => parseInt(event.pc, 16) === cause.pc);
    const wrongBd = fixture.events.map(event => event === causeReads[1]
      || (event.kind === 'dm' && parseInt(event.target, 16) === metadata.logBase + 32 + 16)
      ? { ...event, value: '80001000' } : event);
    expect(checkP7Probe(fixture.diagnostics, wrongBd, metadata).failures
      .some(failure => failure.message.includes('实际分支延迟槽'))).toBe(true);
  });

  it('rejects unknown architectural words whose known hexadecimal prefix resembles the expected value', () => {
    const fixture = run('direct');
    const metadata = fixture.generated.probe!;
    const donePc = metadata.scenarios[1].donePc;
    for (const value of ['0000002x', '0000002z', '100000002']) {
      const events = fixture.events.map(event => parseInt(event.pc, 16) === donePc ? { ...event, value } : event);
      expect(checkP7Probe(fixture.diagnostics, events, metadata).failures
        .some(failure => failure.message.includes(`主程序在 PC 0x${donePc.toString(16)}`))).toBe(true);
    }
  });

  it('rejects protocol reversal, out-of-path EPC and unplanned partial record writes', () => {
    const fixture = run('direct');
    const metadata = fixture.generated.probe!;
    expect(checkP7Probe(fixture.diagnostics.replace('external_ack scenario=1', 'external_ack scenario=9'),
      fixture.events, metadata).passed).toBe(false);
    const badEpc = fixture.events.map(event => event.kind === 'dm' && parseInt(event.target, 16) === metadata.logBase + 32 + 20
      ? { ...event, value: '00003000' } : event);
    expect(checkP7Probe(fixture.diagnostics, badEpc, metadata).passed).toBe(false);
    const partial = { ...fixture.events[0], pc: '00004000', kind: 'dm' as const,
      target: (metadata.logBase + 64).toString(16), value: 'c0a70001' };
    expect(checkP7Probe(fixture.diagnostics, [...fixture.events, partial], metadata).passed).toBe(false);
    const early = fixture.diagnostics + '\nCO_P7_PROBE external_ack_early scenario=1 time=100';
    expect(checkP7Probe(early, fixture.events, metadata).failures).toContainEqual(expect.objectContaining({
      scenarioId: 1, observed: true, message: expect.stringContaining('完成 DM 记录之前')
    }));
    const oldLevelObservations = fixture.diagnostics + '\nCO_P7_PROBE return_ack_store'
      + '\nCO_P7_PROBE invalid_store_effect source=interrupt_generator';
    expect(checkP7Probe(oldLevelObservations, fixture.events, metadata).passed).toBe(true);
  });

  it('binds handler fields and all register writes to their own instruction PCs', () => {
    const fixture = run('direct');
    const metadata = fixture.generated.probe!;
    const stores = metadata.returnBoundary!.handlerCommits.filter(commit => commit.kind === 'dm');
    const swapped = fixture.events.map(event => parseInt(event.pc, 16) === stores[0].pc
      ? { ...event, pc: stores[1].pc.toString(16) }
      : parseInt(event.pc, 16) === stores[1].pc ? { ...event, pc: stores[0].pc.toString(16) } : event);
    expect(checkP7Probe(fixture.diagnostics, swapped, metadata).passed).toBe(false);
    for (const expected of metadata.returnBoundary!.handlerCommits) {
      const commits = fixture.events.filter(event => parseInt(event.pc, 16) === expected.pc);
      expect(commits).toHaveLength(2);
      const bad = fixture.events.map(event => event === commits[1] ? { ...event, value: 'deadbeef' } : event);
      expect(checkP7Probe(fixture.diagnostics, bad, metadata).passed).toBe(false);
    }
  });

  it('rejects an in-path EPC that contradicts the actual retirement boundary', () => {
    const fixture = run('direct');
    const metadata = fixture.generated.probe!;
    const epcRead = metadata.returnBoundary!.handlerCommits.find(commit => commit.kind === 'grf' && commit.value === 'epc')!;
    const secondRead = fixture.events.filter(event => parseInt(event.pc, 16) === epcRead.pc)[1];
    const donePc = metadata.scenarios[1].donePc;
    expect(metadata.scenarios[1].allowedEpc).toContain(donePc);
    const corrupted = fixture.events.map(event => event === secondRead
      || (event.kind === 'dm' && parseInt(event.target, 16) === metadata.logBase + 32 + 20)
      ? { ...event, value: donePc.toString(16) } : event);
    const result = checkP7Probe(fixture.diagnostics, corrupted, metadata);
    expect(result.failures.some(f => f.message.includes('EPC/BD 边界'))).toBe(true);
  });
});
