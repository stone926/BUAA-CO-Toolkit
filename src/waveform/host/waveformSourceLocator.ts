// @index waveform-source — 波形信号/scope 跳回 Verilog 源码：按层次路径解析到模块声明，在波形之外的编辑器列中打开

import * as vscode from 'vscode';
import { textEditorColumn } from '../../editorNavigation';
import { workspaceFolderForOrFirst } from '../../fsUtil';
import type { VerilogModuleProvider } from '../../language/verilog/moduleProvider';
import { findDeclaration, resolveHierarchy } from '../design/designHierarchy';
import { createDesignModuleLookup, workspaceTestbenchSources } from './designModules';

export interface SourceLocation {
  readonly uri: vscode.Uri;
  readonly range: vscode.Range;
}

/**
 * Resolve a dump path (`tb.uut.CPU.GRF.register[3]`) to its declaration, or a
 * scope path to its module definition. VCD scopes are instance names, so the walk
 * starts at the root module (Icarus names the top instance after its module).
 */
export async function locateWaveformSource(
  dumpUri: vscode.Uri,
  hierarchicalPath: string,
  isScope: boolean,
  registry: VerilogModuleProvider | undefined
): Promise<SourceLocation | string> {
  const segments = hierarchicalPath.split('.');
  const folder = workspaceFolderForOrFirst(dumpUri);
  const lookup = await createDesignModuleLookup(
    registry,
    folder ? await workspaceTestbenchSources(folder.uri.fsPath) : []
  );
  const root = lookup(segments[0]);
  if (!root) {
    return `未找到顶层模块 ${segments[0]} 的源码`;
  }
  const scopeSegments = isScope ? segments.slice(1) : segments.slice(1, -1);
  const { module, blocks } = resolveHierarchy(root, scopeSegments, lookup);
  if (isScope) {
    return { uri: vscode.Uri.parse(module.uri), range: toRange(module.selectionRange) };
  }
  const leaf = segments[segments.length - 1];
  const declaration = findDeclaration(module, leaf, blocks);
  if (!declaration) {
    return `模块 ${module.name} 中没有找到 ${leaf} 的声明`;
  }
  return { uri: vscode.Uri.parse(module.uri), range: toRange(declaration.selectionRange) };
}

/** Reveal source in its existing editor group, or the active group if it is not open. */
export async function revealSourceLocation(location: SourceLocation, _waveformColumn?: vscode.ViewColumn): Promise<void> {
  await vscode.window.showTextDocument(location.uri, {
    selection: location.range,
    viewColumn: textEditorColumn(location.uri),
    preview: true,
    preserveFocus: false
  });
}

function toRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}
