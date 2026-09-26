import { describe, expect, it } from 'vitest';
import { sanitizePersistedViewState } from '../../waveform/model/viewStateContract';
import { parseVcd } from '../../waveform/vcd/vcdReader';
import { defaultRadix, defaultSignalPlan, detectClock, findRegisterFile, registerAlias } from '../../waveform/view/signalDefaults';
import { buildSignalTree, collectVarIndexes, flattenSignalTree } from '../../waveform/view/signalTree';
import { SignalRowInput, WaveRowList } from '../../waveform/view/waveRows';

const cpuDump = parseVcd([
  '$timescale 1ps $end',
  '$scope module tb $end',
  '$var reg 1 ! clk $end',
  '$var reg 1 " reset $end',
  '$var wire 32 # i_inst_rdata [31:0] $end',
  '$var wire 32 $ i_inst_addr [31:0] $end',
  '$var integer 32 % i [31:0] $end',
  '$var parameter 6 & MULT $end',
  '$scope module uut $end',
  '$var wire 1 ! clk $end',
  '$var wire 32 \' D_ins [31:0] $end',
  '$var reg 32 ( IR_E [31:0] $end',
  '$scope module grf $end',
  ...Array.from({ length: 32 }, (_, index) => `$var reg 32 r${index} \\regs[${index}] [31:0] $end`),
  '$upscope $end',
  '$scope module tc $end',
  '$var reg 32 m0 \\mem[0] [31:0] $end',
  '$var reg 32 m1 \\mem[1] [31:0] $end',
  '$var reg 32 m2 \\mem[2] [31:0] $end',
  '$upscope $end',
  '$upscope $end',
  '$upscope $end',
  '$enddefinitions $end',
  '#0', '0!', '1"', 'b0 #', 'b0 $', 'b0 %', 'b1100 &', 'b0 \'', 'b0 (',
  '#2', '1!', '#4', '0!', '#6', '1!', '#8', '0!', '#10', '1!'
].join('\n'));

function input(path: string, varIndex = 0): SignalRowInput {
  return { path, varIndex, radix: 'hex' };
}

describe('course-aware signal defaults', () => {
  it('disassembles instruction-carrying signals by default but not addresses', () => {
    const radix = (name: string) => defaultRadix(cpuDump.vars.find((variable) => variable.name === name)!);
    expect(radix('i_inst_rdata')).toBe('instr');
    expect(radix('D_ins')).toBe('instr');
    expect(radix('IR_E')).toBe('instr');
    expect(radix('i_inst_addr')).toBe('hex');
    expect(radix('clk')).toBe('hex');
  });

  it('detects the shallowest toggling clock', () => {
    expect(cpuDump.vars[detectClock(cpuDump)!].path).toBe('tb.clk');
  });

  it('plans testbench-level signals first and offers the 32-word register file', () => {
    const plan = defaultSignalPlan(cpuDump);
    expect(plan.signals.map((index) => cpuDump.vars[index].name)).toEqual(['clk', 'reset', 'i_inst_addr', 'i_inst_rdata']);
    expect(plan.registerFile?.name).toBe('regs');
    expect(plan.registerFile?.words.map((index) => cpuDump.vars[index].name).slice(0, 3)).toEqual(['regs[0]', 'regs[1]', 'regs[2]']);
    expect(findRegisterFile(cpuDump)?.words).toHaveLength(32);
    const word29 = cpuDump.vars.find((variable) => variable.name === 'regs[29]')!;
    expect(registerAlias(cpuDump, word29)).toBe('$sp');
    expect(registerAlias(cpuDump, cpuDump.vars.find((variable) => variable.name === 'mem[1]')!)).toBeUndefined();
  });
});

describe('signal tree', () => {
  const tree = buildSignalTree(cpuDump);

  it('groups memory words into arrays and parameters into their own node', () => {
    expect(tree).toHaveLength(1);
    const tb = tree[0];
    expect(tb.children.map((node) => `${node.kind}:${node.label}`)).toEqual([
      'scope:uut', 'var:clk', 'var:i', 'var:i_inst_addr', 'var:i_inst_rdata', 'var:reset', 'params:参数'
    ]);
    const uut = tb.children[0];
    const grf = uut.children.find((node) => node.label === 'grf')!;
    expect(grf.children).toHaveLength(1);
    expect(grf.children[0]).toMatchObject({ kind: 'array', label: 'regs', detail: '32 × [31:0]' });
    // Natural order: regs[2] before regs[10].
    expect(grf.children[0].children.slice(1, 3).map((node) => node.label)).toEqual(['regs[1]', 'regs[2]']);
    // Case-insensitive natural order, as in the tree.
    expect(collectVarIndexes(uut, false).map((index) => cpuDump.vars[index].name)).toEqual(['clk', 'D_ins', 'IR_E']);
    expect(collectVarIndexes(uut, true)).toHaveLength(3 + 32 + 3);
  });

  it('flattens expanded nodes and filters by name or dotted path', () => {
    const collapsed = flattenSignalTree(tree, new Set(), '');
    expect(collapsed.nodes.map((entry) => entry.node.label)).toEqual(['tb']);
    const expanded = flattenSignalTree(tree, new Set(['s:tb']), '');
    expect(expanded.nodes).toHaveLength(8);
    expect(expanded.nodes[1]).toMatchObject({ depth: 1, expandable: true, expanded: false });

    const search = flattenSignalTree(tree, new Set(), 'ins');
    expect(search.nodes.map((entry) => entry.node.label)).toEqual(['tb', 'uut', 'D_ins', 'i_inst_addr', 'i_inst_rdata']);
    const byPath = flattenSignalTree(tree, new Set(), 'grf.regs[3');
    expect(byPath.nodes.map((entry) => entry.node.label)).toEqual(['tb', 'uut', 'grf', 'regs', 'regs[3]', 'regs[30]', 'regs[31]']);
    const limited = flattenSignalTree(tree, new Set(['s:tb', 's:tb.uut', 's:tb.uut.grf', 'a:tb.uut.grf.regs']), '', 10);
    expect(limited.truncated).toBe(true);
    expect(limited.nodes).toHaveLength(10);
  });
});

describe('waveform rows', () => {
  it('adds without duplicates, groups, moves and removes rows', () => {
    const rows = new WaveRowList();
    const [a, b, c] = rows.addSignals([input('tb.a'), input('tb.b'), input('tb.c'), input('tb.a')]);
    expect(rows.visibleRows().map((row) => row.row.id)).toEqual([a, b, c]);

    const group = rows.groupSignals([b, c], 'bus')!;
    expect(rows.topLevel.map((row) => row.kind)).toEqual(['signal', 'group']);
    rows.addSignals([input('tb.d')], { kind: 'group-end', groupId: group });
    expect(rows.addSignals([input('tb.b')], { kind: 'group-end', groupId: group })).toEqual([]);
    expect(rows.visibleRows().map((row) => (row.row.kind === 'signal' ? row.row.path : row.row.name)))
      .toEqual(['tb.a', 'bus', 'tb.b', 'tb.c', 'tb.d']);

    rows.move([a], undefined);
    expect(rows.topLevel.map((row) => row.id)).toEqual([group, a]);
    rows.move([a], c);
    expect(rows.visibleRows().map((row) => (row.row.kind === 'signal' ? row.row.path : row.row.name)))
      .toEqual(['bus', 'tb.b', 'tb.a', 'tb.c', 'tb.d']);

    const collapsedGroup = rows.find(group)!.row;
    if (collapsedGroup.kind === 'group') {
      collapsedGroup.collapsed = true;
    }
    expect(rows.visibleRows()).toHaveLength(1);

    rows.ungroup(group);
    expect(rows.topLevel).toHaveLength(4);
    rows.remove(new Set([a]));
    expect(rows.allSignals().map((row) => row.path)).toEqual(['tb.b', 'tb.c', 'tb.d']);
  });

  it('never nests a new group inside another group', () => {
    const rows = new WaveRowList();
    const [a, b, c] = rows.addSignals([input('tb.a'), input('tb.b'), input('tb.c')]);
    const outer = rows.groupSignals([b, c], 'outer')!;
    const beforeChild = rows.addGroup('dropped', [input('tb.x'), input('tb.y')], false, { kind: 'before', rowId: c });
    const intoGroup = rows.addGroup('tail', [input('tb.z')], false, { kind: 'group-end', groupId: outer });
    expect(rows.topLevel.map((row) => row.id)).toEqual([a, beforeChild, outer, intoGroup]);
    expect(rows.allSignals().every((row) => row.kind === 'signal')).toBe(true);
    expect(rows.allSignals().map((row) => row.path)).toEqual(['tb.a', 'tb.x', 'tb.y', 'tb.b', 'tb.c', 'tb.z']);
  });

  it('round-trips persisted rows and rebinds after a reload', () => {
    const rows = new WaveRowList();
    rows.addSignals([{ ...input('tb.a', 3), radix: 'sdec', color: 2 }]);
    rows.addGroup('g', [input('tb.b', 4)], true);
    const persisted = rows.toPersisted();
    expect(persisted).toEqual([
      { kind: 'signal', path: 'tb.a', radix: 'sdec', color: 2 },
      { kind: 'group', name: 'g', collapsed: true, rows: [{ kind: 'signal', path: 'tb.b', radix: 'hex' }] }
    ]);
    const restored = new WaveRowList();
    restored.restore({ rows: persisted }, (row) => ({ path: row.path, varIndex: row.path === 'tb.a' ? 7 : -1, radix: row.radix ?? 'hex', ...(row.color !== undefined ? { color: row.color } : {}) }));
    expect(restored.allSignals().map((row) => [row.path, row.varIndex, row.radix])).toEqual([['tb.a', 7, 'sdec'], ['tb.b', -1, 'hex']]);
    restored.rebind((path) => (path === 'tb.b' ? 9 : -1));
    expect(restored.allSignals().map((row) => row.varIndex)).toEqual([-1, 9]);
  });

  it('sanitizes untrusted persisted state', () => {
    expect(sanitizePersistedViewState({ version: 2, rows: [] })).toBeUndefined();
    expect(sanitizePersistedViewState(null)).toBeUndefined();
    const state = sanitizePersistedViewState({
      version: 1,
      rows: [
        { kind: 'signal', path: 'tb.a', radix: 'weird', color: 99 },
        { kind: 'signal', path: '' },
        { kind: 'group', name: 'g', rows: [{ kind: 'signal', path: 'tb.b', radix: 'bin' }, 42] },
        'junk'
      ],
      clock: null,
      viewStart: 0,
      viewEnd: Number.NaN,
      cursor: 5,
      markers: [1, 'x', 3],
      layout: { nameWidth: 10_000, valueWidth: 120, sidebar: 'trace' }
    });
    expect(state).toEqual({
      version: 1,
      rows: [
        { kind: 'signal', path: 'tb.a' },
        { kind: 'group', name: 'g', rows: [{ kind: 'signal', path: 'tb.b', radix: 'bin' }] }
      ],
      clock: null,
      viewStart: 0,
      cursor: 5,
      markers: [{ time: 1 }, { time: 3 }],
      layout: { valueWidth: 120, sidebar: 'trace' }
    });
  });

  it('keeps unique marker labels and still reads markers saved as bare times', () => {
    const state = sanitizePersistedViewState({
      version: 1,
      rows: [],
      markers: [{ time: 5, label: 2 }, { time: 6, label: 2 }, { time: 7, label: 0 }, { time: 8, label: 1.5 }, { time: 'x', label: 3 }, 9, { label: 4 }, null]
    });
    expect(state?.markers).toEqual([{ time: 5, label: 2 }, { time: 6 }, { time: 7 }, { time: 8 }, { time: 9 }]);
    const many = sanitizePersistedViewState({ version: 1, rows: [], markers: Array.from({ length: 70 }, (_, index) => ({ time: index, label: index + 1 })) });
    expect(many?.markers).toHaveLength(64);
  });
});
