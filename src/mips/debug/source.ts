// @index mips-debug — VS Code source snapshots and assembly diagnostics adapter
import * as vscode from 'vscode';
import type { SourceUnit } from '../core/api';
import type { AssemblerDiagnostic } from '../core/assembler/diagnostics';
import { captureAssemblyInput } from '../host/sourceInput';
import { readBoundedRegularFile } from '../replay/boundedFile';

/** Verify the captured closure against both disk and unsaved editor buffers. */
export async function workbenchSourcesCurrent(sources: readonly SourceUnit[]): Promise<boolean> {
  const matches = await Promise.all(sources.map(async source => {
    if (!source.uri) return false;
    const uri = vscode.Uri.parse(source.uri);
    const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
    if (document && document.getText() !== source.text.replace(/^\uFEFF/, '')) return false;
    try {
      const bytes = await readBoundedRegularFile(uri.fsPath, { maximumBytes: 8 * 1024 * 1024, label: 'MARS source freshness' });
      return bytes.toString('utf8') === source.text;
    } catch { return false; }
  }));
  return matches.every(Boolean);
}

export async function captureWorkbenchSource(uri: vscode.Uri, allowedRoot: string): ReturnType<typeof captureAssemblyInput> {
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty && !await document.save()) throw new Error('无法保存当前 ASM 文件');
  // Save only dirty documents in this include closure, then capture the immutable graph again.
  for (let attempt = 0; attempt < 8; attempt++) {
    const input = await captureAssemblyInput(uri.fsPath, allowedRoot);
    const included = new Set(input.sources.map(source => source.uri && vscode.Uri.parse(source.uri).toString()));
    const dirty = vscode.workspace.textDocuments.filter(item => item.isDirty && included.has(item.uri.toString()));
    if (!dirty.length) return input;
    for (const item of dirty) if (!await item.save()) throw new Error(`无法保存 include 文件：${item.uri.fsPath}`);
  }
  throw new Error('源文件持续变化，请保存后重新汇编');
}

export function showAssemblyDiagnostics(collection: vscode.DiagnosticCollection, diagnostics: readonly AssemblerDiagnostic[], sources: readonly SourceUnit[]): void {
  collection.clear();
  const grouped = new Map<string, vscode.Diagnostic[]>();
  for (const item of diagnostics) {
    const source = sources.find(source => source.id === item.span?.sourceId) ?? sources[0];
    if (!source?.uri) continue;
    const offset = Math.min(item.span?.startOffset ?? 0, source.text.length);
    const before = source.text.slice(0, offset).split('\n');
    const start = new vscode.Position(before.length - 1, before[before.length - 1].length);
    const end = new vscode.Position(start.line, start.character + Math.max(1, Math.min(80, (item.span?.endOffset ?? offset + 1) - offset)));
    const diagnostic = new vscode.Diagnostic(new vscode.Range(start, end), item.message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = '内置 MARS'; diagnostic.code = item.code;
    const existing = grouped.get(source.uri) ?? []; existing.push(diagnostic); grouped.set(source.uri, existing);
  }
  for (const [uri, items] of grouped) collection.set(vscode.Uri.parse(uri), items);
}
