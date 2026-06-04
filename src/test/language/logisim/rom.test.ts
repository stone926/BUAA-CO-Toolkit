import { describe, expect, it } from 'vitest';
import {
  findLogisimRomTargets,
  formatLogisimMemoryContents,
  injectMachineCodeIntoLogisimRom,
  parseMachineCodeWords
} from '../../../language/logisim/rom';

describe('Logisim ROM injection', () => {
  it('parses MARS HexText words', () => {
    expect(parseMachineCodeWords([
      'v2.0 raw',
      '34090004',
      '0x34080001',
      '012A4020 # comment',
      'not-hex'
    ].join('\n'))).toEqual(['34090004', '34080001', '012A4020']);
  });

  it('formats Logisim memory contents with addr/data header', () => {
    expect(formatLogisimMemoryContents(['34090004', '34080001'], 12)).toBe([
      'addr/data: 12 32',
      '34090004',
      '34080001',
      ''
    ].join('\n'));
  });

  it('finds ROM targets with label, location, and widths', () => {
    const text = `<project>
  <circuit name="main">
    <comp lib="4" loc="(460,410)" name="ROM">
      <a name="label" val="IM"/>
      <a name="addrWidth" val="16"/>
      <a name="dataWidth" val="32"/>
      <a name="contents">addr/data: 16 32
0
</a>
    </comp>
  </circuit>
</project>`;

    expect(findLogisimRomTargets(text)).toMatchObject([
      {
        index: 0,
        label: 'IM',
        loc: '(460,410)',
        addrWidth: 16,
        dataWidth: 32,
        hasContents: true
      }
    ]);
  });

  it('replaces an existing ROM contents block', () => {
    const text = `<project><circuit name="main">
    <comp lib="4" loc="(460,410)" name="ROM">
      <a name="addrWidth" val="16"/>
      <a name="dataWidth" val="32"/>
      <a name="contents">addr/data: 16 32
0
</a>
    </comp>
</circuit></project>`;

    const result = injectMachineCodeIntoLogisimRom(text, '34090004\n34080001\n', 0);

    expect(result.wordCount).toBe(2);
    expect(result.text).toContain('<a name="contents">addr/data: 16 32\n34090004\n34080001\n</a>');
    expect(result.text).not.toContain('addr/data: 16 32\n0\n');
  });

  it('adds width and contents attributes to an empty ROM component', () => {
    const text = '<project><circuit name="main"><comp lib="4" loc="(460,410)" name="ROM"/></circuit></project>';

    const result = injectMachineCodeIntoLogisimRom(text, '34090004\n34080001\n', 0);

    expect(result.text).toContain('<a name="addrWidth" val="1"/>');
    expect(result.text).toContain('<a name="dataWidth" val="32"/>');
    expect(result.text).toContain('<a name="contents">addr/data: 1 32\n34090004\n34080001\n</a>');
  });

  it('rejects non-32-bit ROM targets', () => {
    const text = `<project><circuit name="main">
      <comp lib="4" name="ROM">
        <a name="dataWidth" val="8"/>
      </comp>
    </circuit></project>`;

    expect(() => injectMachineCodeIntoLogisimRom(text, '34090004\n', 0)).toThrow('expected 32');
  });

  it('can inject into a selected ROM when multiple ROMs exist', () => {
    const text = `<project><circuit name="main">
      <comp lib="4" name="ROM">
        <a name="label" val="Lookup"/>
        <a name="dataWidth" val="8"/>
      </comp>
      <comp lib="4" name="ROM">
        <a name="label" val="IM"/>
        <a name="addrWidth" val="12"/>
        <a name="dataWidth" val="32"/>
      </comp>
    </circuit></project>`;

    const result = injectMachineCodeIntoLogisimRom(text, '34090004\n', 1);

    expect(result.target.label).toBe('IM');
    expect(result.text).toContain('<a name="contents">addr/data: 12 32\n34090004\n</a>');
  });
});
