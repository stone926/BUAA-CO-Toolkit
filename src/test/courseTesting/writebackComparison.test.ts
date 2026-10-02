import { describe, expect, it } from 'vitest';
import { buildWritebackComparison, initialWritebackFocus, maximumWritebackRows } from '../../courseTesting/writebackComparison';

const immediateYield = async () => {};
const build = (oracle: string, dut: string) => buildWritebackComparison(oracle, dut, { yieldControl: immediateYield });

describe('writeback comparison model', () => {
  it('locates the actual dynamic DM transaction rather than the first execution of its PC', async () => {
    const trace = '@3000: $1 <= 0\n@3004: *4 <= 0\n@3008: $2 <= 0\n@3004: *4 <= 0';
    const model = await build(trace, trace);
    expect(initialWritebackFocus(model, { version: 1, index: 1, pc: 0x3004 })).toBe(3);
    expect(initialWritebackFocus(model, { version: 1, index: 1, pc: 0x3010 })).toBe(0);
  });

  it('compares the screenshot log shape despite WARNING, timestamps, spacing and hex case', async () => {
    const model = await build(
      '@00003000: $01 <= 0000000a\r\n@00003004: *00000abc <= deadbeef',
      'WARNING: memory read did not fill requested range\n   38@00003000: $ 1 <= 0000000A\n  48@00003004: *00000ABC <= DEADBEEF\n'
    );
    expect(model.differences).toEqual([]);
    expect(model).toMatchObject({ oracleEvents: 2, dutEvents: 2, truncated: false });
    expect(model.rows.map((row) => row.status)).toEqual(['ok', 'ok']);
    expect(model.rows[0].dut).toMatchObject({ cycle: 38, lineNumber: 2, target: '1' });
    expect(model.rows[0].dut).not.toHaveProperty('raw');
  });

  it('retains decimal register numbers and each dynamic execution of a repeated PC', async () => {
    const model = await build(
      '@3000: $10 <= 1\n@3000: $10 <= 2',
      '38@3000: $010 <= 1\n48@3000: $10 <= 3'
    );
    expect(model.rows).toHaveLength(2);
    expect(model.rows[0].oracle?.target).toBe('10');
    expect(model.rows[1]).toMatchObject({ status: 'diff', changedFields: ['value'] });
    expect(model.differences).toEqual([1]);
  });

  it('shares the automatic comparer same-cycle adjacent swap rule', async () => {
    const oracle = '@3004: *1000 <= 2\n@3000: $1 <= 1';
    const model = await build(oracle, '38@3000: $1 <= 1\n38@3004: *1000 <= 2');
    expect(model.differences).toEqual([]);
    expect(model.rows[0]).toMatchObject({
      status: 'ok', oracle: { pc: '00003004' }, dut: { pc: '00003004', lineNumber: 2 }, changedFields: []
    });
    expect(model.rows[1].dut?.lineNumber).toBe(1);
    const differentCycles = await build(oracle, '38@3000: $1 <= 1\n48@3004: *1000 <= 2');
    expect(differentCycles.differences).toEqual([0, 1]);
    const noCycles = await build(oracle, '@3000: $1 <= 1\n@3004: *1000 <= 2');
    expect(noCycles.differences).toEqual([0, 1]);
  });

  it('reports every changed semantic field and treats target kind as a target change', async () => {
    const model = await build('@3000: $1 <= 1', '@3004: *1 <= 2');
    expect(model.rows[0]).toMatchObject({
      status: 'diff', reason: '指令地址（PC）不一致。', changedFields: ['pc', 'target', 'value']
    });
  });

  it('keeps missing and extra tails as one-sided differences', async () => {
    const short = '@3000: $1 <= 1';
    const long = `${short}\n@3004: $2 <= 2`;
    const missing = await build(long, short);
    expect(missing.rows[1]).toMatchObject({ status: 'oracle-only', changedFields: [] });
    expect(missing.rows[1].dut).toBeUndefined();
    expect(missing.differences).toEqual([1]);
    const extra = await build(short, long);
    expect(extra.rows[1].status).toBe('dut-only');
    expect(extra.rows[1].oracle).toBeUndefined();
  });

  it('returns zero parsed evidence for empty or warning-only traces without declaring a match', async () => {
    const model = await build('WARNING: no execution', '');
    expect(model).toEqual({ rows: [], differences: [], oracleEvents: 0, dutEvents: 0, truncated: false });
    expect(model).not.toHaveProperty('matched');
  });

  it('rejects an already cancelled build', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(buildWritebackComparison('', '', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('yields and permits cancellation while parsing ignored output', async () => {
    const controller = new AbortController();
    let yields = 0;
    await expect(buildWritebackComparison('WARNING: ignored\n'.repeat(10_000), '', {
      signal: controller.signal,
      yieldControl: async () => { yields++; controller.abort(); }
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(yields).toBe(1);
  });

  it('permits cancellation while comparing parsed events', async () => {
    const controller = new AbortController();
    const text = '@3000: $1 <= 1\n'.repeat(4096);
    let yields = 0;
    await expect(buildWritebackComparison(text, text, {
      signal: controller.signal,
      yieldControl: async () => { if (++yields === 5) controller.abort(); }
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(yields).toBe(5);
  });

  it('caps rows and parsed evidence with explicit truncation', async () => {
    const text = '@3000: $1 <= 1\n'.repeat(maximumWritebackRows + 2);
    const model = await build(text, '');
    expect(model.rows).toHaveLength(maximumWritebackRows);
    expect(model.differences).toHaveLength(maximumWritebackRows);
    expect(model).toMatchObject({ oracleEvents: maximumWritebackRows + 1, dutEvents: 0, truncated: true });
    expect(model.rows[model.rows.length - 1]?.index).toBe(maximumWritebackRows - 1);
  });
});
