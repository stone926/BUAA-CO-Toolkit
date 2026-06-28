import { describe, expect, it } from 'vitest';
import {
  analyzeP3LogisimTraceCircuit,
  createLogisimPcProgressState,
  formatP3LogisimTraceDiagnostic,
  formatLogisimTraceEvents,
  inspectLogisimPcProgress,
  logisimRowPcHex,
  parseLogisimTraceOutput,
  parseLogisimTraceSpec,
  p3LogisimTraceProfile,
  p3LogisimMaxProgramWords,
  prepareP3LogisimMachineCode,
  setLogisimMainCircuit,
  validateP3LogisimFetchTrace
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
    <comp lib="0" loc="(60,30)" name="Pin">
      <a name="label" val="reset"/>
    </comp>
    <comp lib="0" loc="(240,40)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(240,90)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(240,140)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
    </comp>
    <comp lib="0" loc="(240,190)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="5"/>
    </comp>
    <comp lib="0" loc="(240,240)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(240,290)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
    </comp>
    <comp lib="0" loc="(240,340)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(240,390)" name="Pin">
      <a name="facing" val="west"/>
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
  </circuit>
</project>`;
}

function projectWithAppearanceOrderedPorts(): string {
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
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="pc"/>
    </comp>
    <comp lib="0" loc="(1130,60)" name="Pin">
      <a name="output" val="true"/>
      <a name="label" val="RegWrite"/>
    </comp>
    <comp lib="0" loc="(1130,110)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="5"/>
    </comp>
    <comp lib="0" loc="(1130,170)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(1130,230)" name="Pin">
      <a name="output" val="true"/>
    </comp>
    <comp lib="0" loc="(240,290)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
      <a name="label" val="Instr"/>
    </comp>
    <comp lib="0" loc="(1140,290)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
    <comp lib="0" loc="(1140,380)" name="Pin">
      <a name="output" val="true"/>
      <a name="width" val="32"/>
    </comp>
  </circuit>
</project>`;
}

function projectWithoutUsableOrder(): string {
  return projectWithAppearanceOrderedPorts().replace(/    <appear>[\s\S]*?    <\/appear>\n/, '');
}

describe('Logisim trace helpers', () => {
  it('derives P3 trace constants from the course profile', () => {
    expect(p3LogisimTraceProfile.defaultCircuit).toBe('main');
    expect(p3LogisimTraceProfile.textBase).toBe(0x3000);
    expect(p3LogisimTraceProfile.romMaxWords).toBe(4096);
    expect(p3LogisimTraceProfile.haltLoopWords).toBe(2);
    expect(p3LogisimMaxProgramWords).toBe(4094);
    expect(p3LogisimTraceProfile.widths.regaddr).toBe(5);
    expect([...p3LogisimTraceProfile.requiredLabels]).toEqual([
      'pc',
      'regwrite',
      'regaddr',
      'regdata',
      'memwrite',
      'memaddr',
      'memdata'
    ]);
  });

  it('orders output pins by position, ignores extra columns, and excludes halt', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');

    expect(spec.hasHalt).toBe(true);
    expect(spec.mappingMode).toBe('labels');
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
    expect(spec.columns.map((column) => column.logisimLabel)).toEqual([
      'Instr',
      'pc',
      'RegWrite',
      'RegAddr',
      'RegData',
      'MemWrite',
      'MemAddr',
      'MemData'
    ]);
    expect(spec.instruction?.index).toBe(0);
    expect(spec.required.pc.index).toBe(1);
    expect(spec.required.memdata.index).toBe(7);
  });

  it('uses tutorial output pin order when P3 trace labels are omitted', () => {
    const spec = parseLogisimTraceSpec(projectWithOrderedUnlabeledPorts(), 'main');

    expect(spec.columns.map((column) => column.label)).toEqual([
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      ''
    ]);
    expect(spec.columns.map((column) => column.logisimLabel)).toEqual([
      'x',
      'y',
      'z',
      'u',
      'v',
      'w',
      's',
      't'
    ]);
    expect(spec.mappingMode).toBe('position');
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

  it('uses appearance order to infer P3 semantics while preserving Logisim CLI column indexes', () => {
    const spec = parseLogisimTraceSpec(projectWithAppearanceOrderedPorts(), 'main');

    expect(spec.mappingMode).toBe('appearance');
    expect(spec.columns.map((column) => column.label)).toEqual([
      'pc',
      'RegWrite',
      '',
      '',
      '',
      'Instr',
      '',
      ''
    ]);
    expect(spec.required.pc.index).toBe(0);
    expect(spec.required.regwrite.index).toBe(1);
    expect(spec.required.regaddr.index).toBe(2);
    expect(spec.required.regdata.index).toBe(3);
    expect(spec.required.memwrite.index).toBe(4);
    expect(spec.required.memaddr.index).toBe(6);
    expect(spec.required.memdata.index).toBe(7);
    expect(spec.instruction?.index).toBe(5);

    const parsed = parseLogisimTraceOutput(
      '00003000\t0\t1 0010\t0000005c\t1\tac12005c\t0000005c\t00000000',
      spec
    );

    expect(parsed.events.map((event) => event.raw)).toEqual([
      '@00003000: *0000005C <= 00000000'
    ]);
  });

  it('reports circuits that cannot be mapped by labels, appearance order, or pin position order', () => {
    expect(() => parseLogisimTraceSpec(projectWithoutUsableOrder(), 'main'))
      .toThrow('cannot identify P3 trace output pins');
  });

  it('supports explicit stdout column mapping for nonstandard layouts', () => {
    const spec = parseLogisimTraceSpec(projectWithoutUsableOrder(), 'main', {
      traceColumns: {
        instr: 5,
        pc: 0,
        regwrite: 1,
        regaddr: 2,
        regdata: 3,
        memwrite: 4,
        memaddr: 6,
        memdata: 7
      }
    });

    expect(spec.mappingMode).toBe('explicit');
    expect(spec.instruction?.index).toBe(5);
    expect(spec.required.memaddr.index).toBe(6);
  });

  it('reports explicit mapping width mistakes', () => {
    expect(() => parseLogisimTraceSpec(projectWithMainPins(), 'main', {
      traceColumns: {
        instr: 0,
        pc: 1,
        regwrite: 2,
        regaddr: 4,
        regdata: 3,
        memwrite: 5,
        memaddr: 6,
        memdata: 7
      }
    })).toThrow('traceColumns.regaddr');
  });

  it('reports partial label conflicts with inferred ordered mapping', () => {
    const conflicted = projectWithAppearanceOrderedPorts()
      .replace('<a name="label" val="pc"/>', '')
      .replace('<a name="label" val="Instr"/>', '<a name="label" val="pc"/>');

    expect(() => parseLogisimTraceSpec(conflicted, 'main'))
      .toThrow('label means "pc"');
  });

  it('formats a useful trace diagnostic report', () => {
    const report = analyzeP3LogisimTraceCircuit(projectWithMainPins(), 'main');
    const text = formatP3LogisimTraceDiagnostic(report);

    expect(report.spec?.mappingMode).toBe('labels');
    expect(text).toContain('P3 Logisim Trace diagnostic');
    expect(text).toContain('#1 label="pc"');
    expect(text).toContain('Termination: injected halt PC via pc column');
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

  it('parses final table rows without a trailing newline and preserves source line numbers', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const parsed = parseLogisimTraceOutput([
      'Logisim startup',
      '0011 0100 0000 0001 0000 0000 0000 0001\t0000 0000 0000 0000 0011 0000 0000 0000\t1\t0 0001\t0000 0000 0000 0000 0000 0000 0000 0001\t0\txxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx\txxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx',
      'halted due to halt pin',
      '1010 1100 0000 0001 0000 0000 0000 0100\t0000 0000 0000 0000 0011 0000 0000 0100\t0\t0 0001\txxxx xxxx xxxx xxxx xxxx xxxx xxxx xxxx\t1\t0000 0000 0000 0000 0000 0000 0000 0100\t0000 0000 0000 0000 0000 0000 0000 0010'
    ].join('\r\n'), spec);

    expect(parsed.rows.map((row) => row.lineNumber)).toEqual([2, 4]);
    expect(parsed.events.map((event) => event.raw)).toEqual([
      '@00003000: $1 <= 00000001',
      '@00003004: *00000004 <= 00000002'
    ]);
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

  it('validates fetched Instr values against generated machine code', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const parsed = parseLogisimTraceOutput([
      '34010001\t00003000\t1\t0 0001\t00000001\t0\t00000000\t00000000',
      '1000ffff\t00003004\t0\t0 0000\t00000000\t0\t00000000\t00000000'
    ].join('\n'), spec);

    expect(() => validateP3LogisimFetchTrace(parsed.rows, spec, ['34010001', '1000ffff'], '00003004'))
      .not.toThrow();
  });

  it('reports fetched Instr mismatches', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const parsed = parseLogisimTraceOutput([
      '34010002\t00003000\t0\t0 0000\t00000000\t0\t00000000\t00000000',
      '1000ffff\t00003004\t0\t0 0000\t00000000\t0\t00000000\t00000000'
    ].join('\n'), spec);

    expect(() => validateP3LogisimFetchTrace(parsed.rows, spec, ['34010001', '1000ffff'], '00003004'))
      .toThrow('instr mismatch');
  });

  it('skips fetch instruction self-check when Instr is not mapped', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins().replace('<a name="label" val="Instr"/>', '<a name="label" val="Debug"/>'), 'main');
    const parsed = parseLogisimTraceOutput([
      'ffffffff\t00003000\t0\t0 0000\t00000000\t0\t00000000\t00000000',
      'eeeeeeee\t00003004\t0\t0 0000\t00000000\t0\t00000000\t00000000'
    ].join('\n'), spec);

    const result = validateP3LogisimFetchTrace(parsed.rows, spec, ['34010001', '1000ffff'], '00003004');

    expect(result.warnings[0]).toContain('no Instr column');
  });

  it('reports unaligned PCs during fetch validation', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const parsed = parseLogisimTraceOutput([
      '34010001\t00003000\t0\t0 0000\t00000000\t0\t00000000\t00000000',
      '1000ffff\t00003002\t0\t0 0000\t00000000\t0\t00000000\t00000000'
    ].join('\n'), spec);

    expect(() => validateP3LogisimFetchTrace(parsed.rows, spec, ['34010001'], '00003004'))
      .toThrow('not 4-byte aligned');
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

  it('reports P3 Logisim PC values outside the generated text range', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const state = createLogisimPcProgressState();
    const result = inspectLogisimPcProgress(
      '00000000\t00000000\t0\t0 0000\t00000000\t0\t00000000\t00000000',
      spec,
      state,
      '00003010'
    );

    expect(result.error).toContain('PC=0x00000000');
    expect(state.rowsSeen).toBe(1);
  });

  it('reports a stuck non-halt PC before waiting for the process timeout', () => {
    const spec = parseLogisimTraceSpec(projectWithMainPins(), 'main');
    const state = createLogisimPcProgressState();
    const line = '00000000\t00003004\t0\t0 0000\t00000000\t0\t00000000\t00000000';

    expect(inspectLogisimPcProgress(line, spec, state, '00003010', 3).error).toBeUndefined();
    expect(inspectLogisimPcProgress(line, spec, state, '00003010', 3).error).toBeUndefined();
    const result = inspectLogisimPcProgress(line, spec, state, '00003010', 3);

    expect(result.error).toContain('连续 3 行停在 0x00003004');
    expect(state.rowsSeen).toBe(3);
  });
});
