// @index verilog-user-testbench — `.co/tb` 用户 testbench：路径约定、按名查找与只创建不覆盖
import * as path from 'path';
import * as vscode from 'vscode';
import { CO_TB_DIR } from '../constants';
import { ensureDirectory, isFile, workspaceFolderForOrFirst, writeTextFileIfAbsent } from '../fsUtil';
import { parseVerilog, VerilogModule } from '../language/verilog/service';
import { isUserTestbenchPath, userTestbenchFileName } from '../verilogSimulationFiles';
import { coSettingsForUri, verilogDocumentForUri } from './documentContext';

export interface UserTestbenchDefinition {
  uri: vscode.Uri;
  module: VerilogModule;
}

/** `<workspace>/.co/tb/<testbench>.v`: generated once, then owned and edited by the user. */
export function userTestbenchUri(resource: vscode.Uri, testbenchName: string): vscode.Uri {
  return vscode.Uri.file(path.join(userTestbenchRoot(resource), ...CO_TB_DIR.split('/'), userTestbenchFileName(testbenchName)));
}

/** Every Verilog file under `.co/tb` is a testbench, whatever its module is called. */
export function isUserTestbenchUri(uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && isUserTestbenchPath(userTestbenchRoot(uri), uri.fsPath);
}

/** Resolve the testbench module declared in `.co/tb/<testbenchName>.v`. */
export async function findUserTestbench(
  resource: vscode.Uri,
  testbenchName: string
): Promise<UserTestbenchDefinition | undefined> {
  const uri = userTestbenchUri(resource, testbenchName);
  if (!await isFile(uri.fsPath)) {
    return undefined;
  }
  const document = await verilogDocumentForUri(uri);
  if (!document) {
    return undefined;
  }
  const module = parseVerilog(document, coSettingsForUri(uri), false).modules
    .find((candidate) => candidate.name === testbenchName);
  return module ? { uri, module } : undefined;
}

/** Create the testbench only when absent, so an existing `.co/tb` file always keeps the user's edits. */
export async function createUserTestbench(uri: vscode.Uri, text: string): Promise<boolean> {
  await ensureDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
  return await writeTextFileIfAbsent(uri, text);
}

function userTestbenchRoot(resource: vscode.Uri): string {
  return workspaceFolderForOrFirst(resource)?.uri.fsPath ?? path.dirname(resource.fsPath);
}
