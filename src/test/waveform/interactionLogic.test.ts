import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizePersistedViewState } from '../../waveform/model/viewStateContract';
import { parseVcd } from '../../waveform/vcd/vcdReader';
import { markerName } from '../../waveform/view/markers';
import { buildSignalTree, firstMatchIndex, flattenSignalTree } from '../../waveform/view/signalTree';
import { dataBounds, minimumViewSpan, zoomView } from '../../waveform/view/viewport';
import { WaveActions } from '../../waveform/webview/actions';
import type { DirtyFlag } from '../../waveform/webview/store';
import { WaveStore } from '../../waveform/webview/store';

const dump = parseVcd([
  '$timescale 1ps $end',
  '$scope module tb $end',
  '$var reg 1 ! clk $end',
  '$var reg 1 " reset $end',
  '$scope module uut $end',
  '$var wire 32 # alu_out [31:0] $end',
  '$var wire 32 $ pc [31:0] $end',
  '$var wire 32 % npc [31:0] $end',
  '$upscope $end',
  '$upscope $end',
  '$enddefinitions $end',
  ...Array.from({ length: 9 }, (_, index) => `#${index * 5}\n${index % 2}!`)
].join('\n'));

describe('zoomView at the span limits', () => {
  const bounds = dataBounds(0, 1000);

  it('does not pan when already zoomed in as far as possible', () => {
    const view = { start: 400, end: 400 + minimumViewSpan };
    expect(zoomView(view, 2, 401.5, bounds)).toEqual(view);
  });

  it('clamps the span before placing the window around the anchor', () => {
    // 3 ticks halved would be 1.5; the span stops at the minimum with the anchor kept in place.
    const next = zoomView({ start: 400, end: 403 }, 2, 403, bounds);
    expect(next.end - next.start).toBe(minimumViewSpan);
    expect((403 - next.start) / (next.end - next.start)).toBeCloseTo(1);
  });

  it('does not pan when already zoomed out as far as possible', () => {
    const widest = zoomView({ start: 0, end: 1000 }, 1e-6, 0, bounds);
    expect(zoomView(widest, 0.5, 900, bounds)).toEqual(widest);
  });
});

describe('signal search selection', () => {
  const tree = buildSignalTree(dump);

  it('selects the first real match, not the ancestor scopes shown above it', () => {
    const flat = flattenSignalTree(tree, new Set(), 'pc').nodes;
    expect(flat.map((entry) => entry.node.label)).toEqual(['tb', 'uut', 'npc', 'pc']);
    expect(flat[firstMatchIndex(flat)].node.label).toBe('npc');
  });

  it('selects a matching scope itself', () => {
    const flat = flattenSignalTree(tree, new Set(), 'uut').nodes;
    expect(flat[firstMatchIndex(flat)].node.label).toBe('uut');
  });

  it('starts at the top without a query and selects nothing without results', () => {
    expect(firstMatchIndex(flattenSignalTree(tree, new Set(), '').nodes)).toBe(0);
    expect(firstMatchIndex([])).toBe(-1);
  });
});

describe('webview store and actions', () => {
  let flushes: Array<() => void>;
  let store: WaveStore;
  let actions: WaveActions;
  const varIndex = (name: string): number => dump.vars.findIndex((variable) => variable.name === name);

  beforeEach(() => {
    flushes = [];
    // Only the persist debounce; animation frames are captured and flushed by drain().
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store = new WaveStore(() => undefined, (callback) => flushes.push(callback));
    store.setDocument(dump, false);
    actions = new WaveActions(store);
    actions.removeAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function drain(): Set<DirtyFlag> {
    const dirty = new Set<DirtyFlag>();
    store.onChange((flags) => flags.forEach((flag) => dirty.add(flag)));
    flushes.splice(0).forEach((flush) => flush());
    return dirty;
  }

  it('refreshes the status bar cycle count when the clock changes', () => {
    drain();
    actions.setClock(undefined);
    expect(store.cycles).toBeUndefined();
    expect(drain().has('status')).toBe(true);
  });

  it('moves the selection from hidden children onto their collapsed group', () => {
    actions.addGroup('uut', [varIndex('alu_out'), varIndex('pc'), varIndex('npc')]);
    const group = store.rows.topLevel[0];
    const [alu, pc] = group.kind === 'group' ? group.children : [];
    actions.select(alu.id, 'replace');
    actions.select(pc.id, 'toggle');
    actions.toggleGroup(group.id, true);
    expect([...store.selection]).toEqual([group.id]);
    expect(store.selectionAnchor).toBe(group.id);
    // A collapsed group is not a signal, so edge stepping cannot follow a hidden child.
    expect(actions.focusedSignal()).toBeUndefined();

    actions.toggleGroup(group.id, false);
    expect([...store.selection]).toEqual([group.id]);
  });

  it('hands a selected group\'s selection to the signals it releases', () => {
    actions.addGroup('uut', [varIndex('alu_out'), varIndex('pc')]);
    const group = store.rows.topLevel[0];
    const children = group.kind === 'group' ? group.children.map((child) => child.id) : [];
    actions.select(group.id, 'replace');
    actions.ungroup(group.id);
    expect(new Set(store.selection)).toEqual(new Set(children));
    expect(store.selectionAnchor).toBe(children[0]);
  });

  it('repairs the anchor after removals and falls back to a plain selection for ranges', () => {
    actions.addSignals([varIndex('clk'), varIndex('reset'), varIndex('pc')]);
    const [clk, reset, pc] = store.rows.topLevel.map((row) => row.id);
    actions.select(clk, 'replace');
    actions.select(reset, 'toggle');
    actions.removeSelected();
    expect(store.selection.size).toBe(0);
    expect(store.selectionAnchor).toBeUndefined();

    actions.select(pc, 'range');
    expect([...store.selection]).toEqual([pc]);
    expect(store.selectionAnchor).toBe(pc);

    actions.removeAll();
    expect(store.selectionAnchor).toBeUndefined();
  });

  it('deletes a single marker without renaming the others, across saving and reopening', () => {
    [10, 20, 30].forEach((time) => actions.addMarker(time));
    drain();
    actions.removeMarker(2);
    expect(drain()).toEqual(new Set(['waves', 'ruler', 'overview', 'toolbar']));
    expect(store.markers.all.map(markerName)).toEqual(['M1', 'M3']);
    expect(store.markers.active?.label).toBe(3);

    const saved = sanitizePersistedViewState(store.snapshot());
    expect(saved?.markers).toEqual([{ time: 10, label: 1 }, { time: 30, label: 3 }]);
    const reopened = new WaveStore(() => undefined, () => undefined);
    reopened.setSavedState(saved);
    reopened.setDocument(dump, false);
    expect(reopened.markers.all.map(markerName)).toEqual(['M1', 'M3']);
  });

  it('steps to markers in time order and drops the ones a shorter reload leaves out', () => {
    actions.setCursor(0);
    [30, 10].forEach((time) => actions.addMarker(time));
    actions.navigateMarker(1);
    expect(store.cursor).toBe(10);
    expect(store.markers.active?.label).toBe(2);
    actions.navigateMarker(1);
    expect(store.cursor).toBe(30);
    expect(store.markers.active?.label).toBe(1);
    actions.removeNearestMarker();
    expect(store.markers.all.map(markerName)).toEqual(['M2']);

    actions.addMarker(40);
    store.setDocument(parseVcd(['$timescale 1ps $end', '$scope module tb $end', '$var reg 1 ! clk $end', '$upscope $end', '$enddefinitions $end', '#0', '0!', '#20', '1!'].join('\n')), true);
    expect(store.markers.all.map(markerName)).toEqual(['M2']);
    expect(store.markers.active?.label).toBe(2);
  });

  it('extends a range from a visible anchor', () => {
    actions.addSignals([varIndex('clk'), varIndex('reset'), varIndex('pc')]);
    const [clk, reset, pc] = store.rows.topLevel.map((row) => row.id);
    actions.select(pc, 'replace');
    actions.select(clk, 'range');
    expect(new Set(store.selection)).toEqual(new Set([clk, reset, pc]));
    expect(store.selectionAnchor).toBe(pc);
  });
});
