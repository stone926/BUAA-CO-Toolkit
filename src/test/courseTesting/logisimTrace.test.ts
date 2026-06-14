import { describe, expect, it } from 'vitest';
import {
  formatLogisimTraceEvents,
  logisimRowPcHex,
  parseLogisimTraceOutput,
  parseLogisimTraceSpec,
  p3LogisimMaxProgramWords,
  prepareP3LogisimMachineCode,
  setLogisimMainCircuit
} from '../../courseTesting/logisimTrace';

function projectWithMainPins(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="2.7.1" version="1.0">
  <main name="GRF"/>
  <circuit name="main">
    <comp lib="0" loc="(140,420)" name="Pin">
      <a name="output" val="true"/>
      <a name="label" val="MemWrite"/>
    </comp>
    <comp lib="0" loc="(140,60)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="Instr"/>
    </comp>
    <comp lib="0" loc="(140,160)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="pc"/>
    </comp>
    <comp lib="0" loc="(140,240)" name="Pin">
      <a name="output" val="true"/>
      <a name="label" val="RegWrite"/>
    </comp>
    <comp lib="0" loc="(140,280)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="5"/>
      <a name="label" val="RegAddr"/>
    </comp>
    <comp lib="0" loc="(140,350)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="RegData"/>
    </comp>
    <comp lib="0" loc="(140,490)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="MemAddr"/>
    </comp>
    <comp lib="0" loc="(140,590)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="MemData"/>
    </comp>
    <comp lib="0" loc="(140,650)" name="Pin">
      <a name="output" val="true"/>
      <a name="label" val="halt"/>
    </comp>
  </circuit>
</project>`;
}

function projectWithOrderedUnlabeledPorts(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<project source="2.7.1" version="1.0">
  <main name="main"/>
  <circuit name="main">
    <appear>
      <circ-port height="8" pin="60,30" width="8" x="46" y="86"/>
      <circ-port height="10" pin="240,60" width="10" x="75" y="65"/>
      <circ-port height="10" pin="1130,60" width="10" x="75" y="75"/>
      <circ-port height="10" pin="1130,110" width="10" x="75" y="85"/>
      <circ-port height="10" pin="1130,170" width="10" x="75" y="95"/>
      <circ-port height="10" pin="1130,230" width="10" x="75" y="105"/>
      <circ-port height="10" pin="1140,290" width="10" x="75" y="115"/>
      <circ-port height="10" pin="240,290" width="10" x="75" y="55"/>
      <circ-port height="10" pin="1140,380" width="10" x="75" y="125"/>
    </appear>
    <comp lib="0" loc="(60,30)" name="Pin">
      <a name="label" val="reset"/>
    </comp>
    <comp lib="0" loc="(240,60)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="pc"/>
    </comp>
    <comp lib="0" loc="(1130,60)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="label" val="RegWrite"/>
    </comp>
    <comp lib="0" loc="(1130,110)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="5"/>
    </comp>
    <comp lib="0" loc="(1130,170)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(1130,230)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
    </comp>
    <comp lib="0" loc="(240,290)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="Instr"/>
    </comp>
    <comp lib="0" loc="(1140,290)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(1140,380)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
  </circuit>
</project>`;
}

describe('Logisim trace helpers', () => {
  it('orders output pins by position, ignores extra columns, and excludes halt', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');

    expect(spec.hasHalt).toBe(true);
    expect(spec.columns.map((column) => column.label)).toEqual([
      'Instr',
      'pc',
      'RegWrite',
      'RegAddr',
      'RegData',
      'MemWrite',
      'MemAddr',
      'MemData'
    ]);
    expect(spec.required.pc.index).toBe(1);
    expect(spec.required.memdata.index).toBe(7);
  });

  it('uses appearance port order when P3 trace labels are omitted', () => {
    const spec = parseLogisimTraceSpec(projectWithOrderedUnlabeledPorts(), 'main');

    expect(spec.columns.map((column) => column.label)).toEqual([
      'Instr',
      'pc',
      'RegWrite',
      '',
      '',
      '',
      '',
      ''
    ]);
    expect(spec.required.pc.index).toBe(1);
    expect(spec.required.regaddr.index).toBe(3);
    expect(spec.required.memwrite.index).toBe(5);
    expect(spec.required.memdata.index).toBe(7);

    const parsed = parseLogisimTraceOutput(
      '34010001\t00003000\t1\t00001\t00000001\t0\txxxxxxxx\txxxxxxxx',
      spec
    );

    expect(parsed.events.map((event) => event.raw)).toEqual([
      '@00003000: $1 <= 00000001'
    ]);
  });

  it('parses table rows and converts Logisim writes into CPU trace events', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const text = [
      '0011 0100 0000 0001 0000 0000 0000 0001\t0000 0000 0000 0000 0011 0000 0000 0000\t1\t0 0001\t0000 0000 0000 0000 0000 0000 0000 0001\t0\txxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx\txxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx',
      '1010 1100 0000 0001 0000 0000 0000 0100\t0000 0000 0000 0000 0011 0000 0000 0100\t0\t0 0001\txxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx\t1\t0000 0000 0000 0000 0000 0000 0000 0100\t0000 0000 0000 0000 0000 0000 0000 0010',
      'halted due to halt pin',
      '0 Hz (0 ticks in 0 milliseconds)'
    ].join('\n');

    const parsed = parseLogisimTraceOutput(text, spec);

    expect(parsed.rows).toHaveLength(2);
    expect(parsed.events.map((event) => event.raw)).toEqual([
      '@00003000: $1 <= 00000001',
      '@00003004: *00000004 <= 00000002'
    ]);
    expect(formatLogisimTraceEvents(parsed.events)).toBe([
      '@00003000: $1 <= 00000001',
      '@00003004: *00000004 <= 00000002',
      ''
    ].join('\n'));
  });

  it('skips register zero writes and no-write rows with unused unknown data fields', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const text = [
      '00000000\t00003000\t1\t0 0000\t00000001\t0\txxxxxxxx\txxxxxxxx',
      '00000000\t00003004\t0\t0 0010\txxxxxxxx\t0\txxxxxxxx\txxxxxxxx'
    ].join('\n');

    const parsed = parseLogisimTraceOutput(text, spec);

    expect(parsed.events).toEqual([]);
  });

  it('reports unknown values when the write event needs them', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const text = '00000000\t00003000\t1\t0 0010\txxxxxxxx\t0\txxxxxxxx\txxxxxxxx';

    expect(() => parseLogisimTraceOutput(text, spec)).toThrow('unknown regdata');
  });

  it('computes the P3 halt PC and enforces the 4094-word program limit', () => {
    const ok = prepareP3LogisimMachineCode('34010001\n34020002\n');
    expect(ok.originalWordCount).toBe(2);
    expect(ok.terminatedWordCount).toBe(4);
    expect(ok.haltPcHex).toBe('00003008');
    expect(ok.text).toContain('1000ffff');

    const maxProgram = Array.from({ length: p3LogisimMaxProgramWords }, () => '00000000').join('\n');
    expect(prepareP3LogisimMachineCode(maxProgram).terminatedWordCount).toBe(4096);

    const tooLong = `${maxProgram}\n00000000\n`;
    expect(() => prepareP3LogisimMachineCode(tooLong)).toThrow('maximum is 4094');
  });

  it('updates the command-line main circuit without touching the original circuit body', () => {
    const updated = setLogisimMainCircuit(projectWithMainPins(), 'main');
    expect(updated).toContain('<main name="main"/>');
    expect(updated).toContain('<circuit name="main">');
  });

  it('extracts a row PC for streaming halt detection', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    expect(logisimRowPcHex('00000000\t00003008\t0\t0 0000\t00000000\t0\t00000000\t00000000', spec)).toBe('00003008');
    expect(logisimRowPcHex('halted due to halt pin', spec)).toBeUndefined();
  });
});
