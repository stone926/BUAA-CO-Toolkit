import { describe, expect, it } from 'vitest';
import { prepareP3LogisimReset } from '../../courseTesting/logisimReset';
import { createLogisimPcProgressState, inspectLogisimPcProgress, parseLogisimTraceOutput, parseLogisimTraceSpec } from '../../courseTesting/logisimTrace';

function project(appearance = false): string {
  const ports = [32, 32, 1, 5, 32, 1, 32, 32].map((width, index) =>
    `<comp lib="w" name="Pin" loc="(500,${100 + index * 50})"><a name="output" val="true"/><a name="width" val="${width}"/></comp>`).join('');
  return `<project><lib name="w" desc="#Wiring"/><lib name="m" desc="#Memory"/><lib name="g" desc="#Gates"/>
    <main name="main"/><circuit name="main">${appearance ? `<appear>${[0, 1, 2, 3, 4, 5, 6, 7].map(index =>
      `<circ-port x="100" y="${index * 10}" pin="500,${100 + index * 50}"/>`).join('')}<circ-port x="0" y="0" pin="50,50"/></appear>` : ''}
    <comp lib="w" name="Clock" loc="(100,50)"/>
    <comp lib="w" name="Pin" loc="(50,50)"><a name="label" val="reset"/></comp>${ports}</circuit></project>`;
}

describe('P3 automatic Logisim reset', () => {
  it.each([false, true])('drives the public reset and preserves all trace columns (appearance=%s)', appearance => {
    const text = project(appearance);
    const spec = parseLogisimTraceSpec(text);
    const prepared = prepareP3LogisimReset(text, spec);
    expect(prepared.applied).toBe(true);
    expect(prepared.traceSpec.resetColumn).toBe(8);
    expect(prepared.traceSpec.columns).toHaveLength(9);
    for (const [label, column] of Object.entries(spec.required)) {
      expect(prepared.traceSpec.required[label as keyof typeof spec.required].index).toBe(column.index);
    }
    expect(prepared.text).toContain('trigger" val="falling"');
    expect(prepared.text).toContain('<comp lib="w" name="Tunnel" loc="(50,50)">');
    expect(prepared.text).toContain('<comp lib="m" name="Register"');
    if (appearance) expect(prepared.text).not.toContain('pin="50,50"');
  });

  it('excludes reset rows from both streaming PC checks and architectural writes', () => {
    const prepared = prepareP3LogisimReset(project(), parseLogisimTraceSpec(project()));
    const resetRow = '00000000\t00000000\t1\t00001\t00000001\t1\t00000000\t00000001\t1';
    const executionRow = '00000000\t00003000\t1\t00001\t00000001\t0\t00000000\t00000000\t0';
    const progress = createLogisimPcProgressState();
    expect(inspectLogisimPcProgress(resetRow, prepared.traceSpec, progress, '00003004').rowSeen).toBe(false);
    expect(inspectLogisimPcProgress(executionRow, prepared.traceSpec, progress, '00003004').error).toBeUndefined();
    expect(progress.rowsSeen).toBe(1);
    const parsed = parseLogisimTraceOutput(`${resetRow}\n${executionRow}\n`, prepared.traceSpec);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].pc).toBe('00003000');
    expect(() => parseLogisimTraceOutput(executionRow.replace(/0$/, 'x'), prepared.traceSpec)).toThrow('复位标记未知');
  });

  it('preserves self-initializing harnesses with no reset input', () => {
    const text = project().replace('<a name="label" val="reset"/>', '<a name="label" val="other"/>');
    const spec = parseLogisimTraceSpec(text);
    expect(prepareP3LogisimReset(text, spec)).toEqual({ text, traceSpec: spec, applied: false });
  });

  it('rejects ambiguous reset wiring instead of guessing', () => {
    const text = project().replace('name="Clock"', 'name="Tunnel"');
    expect(() => prepareP3LogisimReset(text, parseLogisimTraceSpec(text))).toThrow('唯一的内置 Clock');
    const wide = project().replace('<a name="label" val="reset"/>', '<a name="label" val="reset"/><a name="width" val="2"/>');
    expect(() => prepareP3LogisimReset(wide, parseLogisimTraceSpec(wide))).toThrow('唯一的 1 位 reset');
  });
});
