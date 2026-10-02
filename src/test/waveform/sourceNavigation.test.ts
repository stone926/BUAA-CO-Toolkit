import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

const vscodeState = vi.hoisted(() => ({
  folders: [] as Array<{ uri: { fsPath: string } }>,
  groups: [] as Array<{ viewColumn: number; tabs: Array<{ input: unknown }> }>,
  activeGroup: undefined as { viewColumn: number; tabs: Array<{ input: unknown }> } | undefined,
  executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
  showTextDocument: vi.fn(async (..._args: unknown[]) => undefined)
}));

vi.mock('vscode', async () => {
  const { URI: Uri } = await import('vscode-uri');
  class Range {
    constructor(readonly startLine: number, readonly startCharacter: number, readonly endLine: number, readonly endCharacter: number) {}
  }
  return {
    Uri,
    Range,
    ViewColumn: { Active: -1, One: 1, Beside: -2 },
    TabInputText: class TabInputText { constructor(readonly uri: URI) {} },
    TabInputCustom: class TabInputCustom { constructor(readonly uri: URI, readonly viewType: string) {} },
    window: {
      activeTextEditor: undefined,
      tabGroups: {
        get all() { return vscodeState.groups; },
        get activeTabGroup() { return vscodeState.activeGroup; }
      },
      showTextDocument: vscodeState.showTextDocument
    },
    commands: { executeCommand: vscodeState.executeCommand },
    workspace: {
      get workspaceFolders() {
        return vscodeState.folders;
      },
      getWorkspaceFolder: (uri: URI) => vscodeState.folders.find((folder) => uri.fsPath.startsWith(folder.uri.fsPath))
    }
  };
});

import { parseModules } from '../../language/verilog/parser';
import type { VerilogModuleProvider } from '../../language/verilog/moduleProvider';
import { locateDumpFile } from '../../waveform/host/waveformSimulation';
import { locateWaveformSource, revealSourceLocation } from '../../waveform/host/waveformSourceLocator';
import { openWaveformEditor } from '../../waveform/host/waveformEditorProvider';
import { WAVEFORM_VIEW_TYPE } from '../../constants';
import { normalizePathKey } from '../../pathUtils';

// vscode-uri lower-cases Windows drive letters; compare paths the way the extension does.
const key = (value: string | undefined): string => normalizePathKey(value ?? '');

const cpu = `module cpu(input clk);
    reg [31:0] regs [0:31];
    wire [31:0] pc;
endmodule
`;

describe('waveform source navigation', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'co 源码-'));
    vscodeState.folders = [{ uri: URI.file(directory) }];
    vscodeState.groups = [];
    vscodeState.activeGroup = undefined;
    vscodeState.executeCommand.mockClear();
    vscodeState.showTextDocument.mockClear();
    fs.mkdirSync(path.join(directory, '.co', 'tb'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.co', 'tb', 'tb.v'), 'module tb;\n    reg clk;\n    cpu uut(.clk(clk));\nendmodule\n');
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function registry(): VerilogModuleProvider {
    const uri = URI.file(path.join(directory, 'cpu.v')).toString();
    const modules = parseModules(TextDocument.create(uri, 'verilog', 0, cpu), cpu);
    return {
      scanning: false,
      getModule: (name) => modules.find((module) => module.name === name),
      getModules: () => modules,
      allModules: () => modules
    };
  }

  it('resolves signals, memory words and scopes through .co testbenches', async () => {
    const dump = URI.file(path.join(directory, '.co', 'wave', 'tb.vcd'));
    const word = await locateWaveformSource(dump as never, 'tb.uut.regs[7]', false, registry());
    expect(typeof word).toBe('object');
    expect(key((word as unknown as { uri: URI }).uri.fsPath)).toBe(key(path.join(directory, 'cpu.v')));
    expect((word as unknown as { range: { startLine: number } }).range.startLine).toBe(1);

    const scope = await locateWaveformSource(dump as never, 'tb.uut', true, registry());
    expect((scope as unknown as { range: { startLine: number } }).range.startLine).toBe(0);

    const testbenchSignal = await locateWaveformSource(dump as never, 'tb.clk', false, registry());
    expect(key((testbenchSignal as unknown as { uri: URI }).uri.fsPath)).toBe(key(path.join(directory, '.co', 'tb', 'tb.v')));

    expect(await locateWaveformSource(dump as never, 'tb.uut.missing', false, registry())).toContain('missing');
    expect(await locateWaveformSource(dump as never, 'other.x', false, registry())).toContain('other');
  });

  it('follows the dump the simulator actually opened', () => {
    const workdir = path.join(directory, '.co', 'isim');
    expect(key(locateDumpFile('VCD info: dumpfile ../wave/tb.vcd opened for output.\n', workdir)?.fsPath))
      .toBe(key(path.join(directory, '.co', 'wave', 'tb.vcd')));
    expect(key(locateDumpFile('VCD warning: something\nVCD info: dumpfile my wave.vcd opened for output.', workdir)?.fsPath))
      .toBe(key(path.join(workdir, 'my wave.vcd')));
    expect(locateDumpFile('no dump', workdir)).toBeUndefined();
  });

  it('opens new waveforms and source jumps in existing or active groups without splitting', async () => {
    const source = URI.file(path.join(directory, 'cpu.v'));
    const sourceGroup = { viewColumn: 3, tabs: [{ input: new (await import('vscode')).TabInputText(source) }] };
    vscodeState.groups = [sourceGroup];
    vscodeState.activeGroup = sourceGroup;
    await revealSourceLocation({ uri: source as never, range: new (await import('vscode')).Range(1, 0, 1, 2) as never }, 1 as never);
    expect(vscodeState.showTextDocument).toHaveBeenCalledWith(source, expect.objectContaining({ viewColumn: 3 }));

    const dump = URI.file(path.join(directory, '.co', 'wave', 'tb.vcd'));
    await openWaveformEditor(dump as never);
    expect(vscodeState.executeCommand).toHaveBeenLastCalledWith('vscode.openWith', dump, WAVEFORM_VIEW_TYPE,
      expect.objectContaining({ viewColumn: -1 }));

    const waveformGroup = { viewColumn: 4, tabs: [{ input: new (await import('vscode')).TabInputCustom(dump, WAVEFORM_VIEW_TYPE) }] };
    vscodeState.groups = [sourceGroup, waveformGroup];
    await openWaveformEditor(dump as never);
    expect(vscodeState.executeCommand).toHaveBeenLastCalledWith('vscode.openWith', dump, WAVEFORM_VIEW_TYPE,
      expect.objectContaining({ viewColumn: 4 }));

    const notOpen = URI.file(path.join(directory, 'include.v'));
    await revealSourceLocation({ uri: notOpen as never, range: new (await import('vscode')).Range(0, 0, 0, 1) as never }, 4 as never);
    expect(vscodeState.showTextDocument).toHaveBeenLastCalledWith(notOpen, expect.objectContaining({ viewColumn: -1 }));
  });
});
