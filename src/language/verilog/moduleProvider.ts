import type * as vscode from 'vscode';
import type { VerilogModule } from './model';
import type { ProjectScope } from '../../projectSettings';

export interface VerilogModuleSource {
  uri: string;
  modules: readonly VerilogModule[];
  displayFormats: readonly string[];
}

export interface VerilogModuleProvider {
  readonly scanning: boolean;
  getModule(name: string, fromUri?: string): VerilogModule | undefined;
  getModules(name: string, fromUri?: string): VerilogModule[];
  allModules(): VerilogModule[];
  getProjectSources?(fromUri?: string): readonly VerilogModuleSource[];
  getProjectScopes?(fromUri: string): readonly ProjectScope[];
}

export interface MutableVerilogModuleProvider extends VerilogModuleProvider {
  updateUri(uri: vscode.Uri): void;
  removeUri(uri: vscode.Uri): void;
}
