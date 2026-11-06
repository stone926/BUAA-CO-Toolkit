import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildProfileInferenceInput, clearProfileInferenceCache } from '../profileInference';
import { WorkspaceModuleRegistry } from '../language/verilog/workspaceModuleRegistry';
import { activeProjectResource, clearActiveProjectResource } from '../configurationResource';
import { ensureConcreteProfile, getProfileResolution, setProfileInferenceProvider } from '../config';

const mocks = vi.hoisted(() => ({
  state: undefined as ReturnType<typeof import('./helpers/vscodeMock').createVscodeMockState> | undefined
}));
vi.mock('vscode', async () => {
  const { createVscodeMockState, createVscodeModuleMock } = await import('./helpers/vscodeMock');
  mocks.state = createVscodeMockState();
  return createVscodeModuleMock(mocks.state, vi.fn);
});

const root = path.resolve('profile projects 中文');
let registry: WorkspaceModuleRegistry;
function source(file: string, text: string): vscode.Uri {
  const uri = vscode.Uri.file(path.join(root, file));
  const document = { uri, languageId: 'verilog', version: 1, getText: () => text };
  mocks.state!.textDocuments.push(document);
  registry.updateDocument(document as vscode.TextDocument);
  return uri;
}

describe('project-scoped Profile inference', () => {
  afterEach(() => { registry.dispose(); setProfileInferenceProvider(undefined); clearActiveProjectResource(); });
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state!.config.clear();
    mocks.state!.textDocuments.splice(0);
    mocks.state!.workspaceFolders.splice(0);
    mocks.state!.workspaceFolders.push({ uri: vscode.Uri.file(root), name: 'profiles' });
    mocks.state!.activeTextEditor = undefined;
    clearActiveProjectResource();
    clearProfileInferenceCache();
    registry = new WorkspaceModuleRegistry();
    setProfileInferenceProvider((resource) => buildProfileInferenceInput(resource, registry));
  });

  it('resolves a helper in P4/P5 using only its own CPU and active trace branch', async () => {
    source('p4/mips.v', 'module mips(input clk, input reset); regs u(); endmodule');
    source('p4/regs.v', 'module regs; initial $display("@%h: $%d <= %h", pc, id, data); endmodule');
    const p4 = source('p4/B_Decoder.v', 'module decoder; endmodule');
    source('p5/mips.v', [
      'module mips(input clk, input reset);',
      '`ifdef SOMETHING_LIKE_LOCAL_TEST',
      'initial $display("@%h: $%d <= %h", pc, id, data);',
      '`else',
      'initial $display("%d@%h: $%d <= %h", $time, pc, id, data);',
      '`endif',
      'endmodule'
    ].join('\n'));
    const p5 = source('p5/B_Decoder.v', 'module decoder; endmodule');
    const header = source('p5/defs.vh', '`define WIDTH 32');

    expect(getProfileResolution(p4).effectiveProfile).toBe('P4');
    expect(getProfileResolution(p5).effectiveProfile).toBe('P5');
    expect(getProfileResolution(header).effectiveProfile).toBe('P5');
    expect(await ensureConcreteProfile(p5)).toBe('P5');
    expect(getProfileResolution(p4).effectiveProfile).toBe('P4');
    expect(vscode.workspace.getConfiguration('co').update).not.toHaveBeenCalled();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('retains source context while a report has focus and switches back with the editor', () => {
    const p4 = source('p4/mips.v', 'module mips(input clk, input reset); initial $display("@%h: $%d <= %h", pc,id,data); endmodule');
    const p5 = source('p5/mips.v', 'module mips(input clk, input reset); initial $display("%d@%h: $%d <= %h", $time,pc,id,data); endmodule');
    mocks.state!.activeTextEditor = { document: { uri: p5, languageId: 'verilog' } };
    expect(getProfileResolution().effectiveProfile).toBe('P5');
    mocks.state!.activeTextEditor = undefined;
    expect(activeProjectResource()?.toString()).toBe(p5.toString());
    expect(getProfileResolution().effectiveProfile).toBe('P5');
    mocks.state!.activeTextEditor = { document: { uri: p4, languageId: 'verilog' } };
    expect(getProfileResolution().effectiveProfile).toBe('P4');
  });

  it('uses file-level defines and refreshes trace evidence after an edit', () => {
    const conditional = [
      'module mips(input clk, input reset);',
      '`ifdef LOCAL',
      'initial $display("@%h: $%d <= %h", pc,id,data);',
      '`else',
      'initial $display("%d@%h: $%d <= %h", $time,pc,id,data);',
      '`endif', 'endmodule'
    ].join('\n');
    const uri = source('mips.v', '`define LOCAL\n' + conditional);
    expect(getProfileResolution(uri).effectiveProfile).toBe('P4');
    source('mips.v', conditional);
    expect(getProfileResolution(uri).effectiveProfile).toBe('P5');
    mocks.state!.config.set('co.project.profile', 'P6');
    expect(getProfileResolution(uri).effectiveProfile).toBe('P6');
  });

  it('waits for initial source discovery before resolving a command from a helper file', async () => {
    const helper = source('p5/B_Decoder.v', 'module decoder; endmodule');
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => { finish = resolve; });
    setProfileInferenceProvider((resource) => buildProfileInferenceInput(resource, registry), () => ready);
    const pending = ensureConcreteProfile(helper);
    await Promise.resolve();
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
    source('p5/mips.v', 'module mips(input clk, input reset); initial $display("%d@%h: $%d <= %h", $time,pc,id,data); endmodule');
    finish();
    expect(await pending).toBe('P5');
    expect(vscode.workspace.getConfiguration('co').update).not.toHaveBeenCalled();
  });
});
