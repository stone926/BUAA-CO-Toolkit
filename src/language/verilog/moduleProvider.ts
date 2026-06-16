import type * as vscode from 'vscode';
import type { VerilogModule } from './model';

export interface VerilogModuleProvider {
  readonly scanning: boolean;
  getModule(name: string): VerilogModule | undefined;
  getModules(name: string): VerilogModule[];
  allModules(): VerilogModule[];
}

export interface MutableVerilogModuleProvider extends VerilogModuleProvider {
  updateUri(uri: vscode.Uri): void;
  removeUri(uri: vscode.Uri): void;
}
