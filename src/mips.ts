import * as path from 'path';
import * as vscode from 'vscode';
import {
  getJava,
  getMachineCode,
  getMarsJar,
  getMemoryConfiguration,
  useDelayedBranching
} from './config';
import { basenameNoExt, dirname, ensureDirectory, writeTextFile } from './fsUtil';
import { runTool } from './process';
import { AppServices } from './types';

export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.mips.disablePseudoWarnings', async () => {
      await vscode.workspace.getConfiguration('co').update('mips.warnPseudoInstruction', false, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage('Disabled MIPS pseudo-instruction warnings in this workspace.');
    }),
    vscode.commands.registerCommand('co.mips.runCurrentFile', () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand('co.mips.dumpText', () => runMarsCurrentFile(services, 'dumpText')),
    vscode.commands.registerCommand('co.mips.dumpKernelText', () => runMarsCurrentFile(services, 'dumpKernel'))
  );
}

async function runMarsCurrentFile(services: AppServices, mode: 'run' | 'dumpText' | 'dumpKernel'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'mipsasm') {
    vscode.window.showErrorMessage('Open a MIPS ASM file first.');
    return;
  }
  const document = editor.document;
  if (document.isUntitled) {
    vscode.window.showErrorMessage('Save the ASM file before running MARS.');
    return;
  }
  if (document.isDirty) {
    await document.save();
  }

  const mars = getMarsJar(document.uri);
  if (!mars) {
    vscode.window.showErrorMessage('MARS jar is not configured. Set co.toolchain.mars or co.toolchain.marsP7.');
    return;
  }

  services.output.show(true);
  const java = getJava(document.uri);
  const cwd = dirname(document.uri);
  const asm = document.uri.fsPath;
  const args = ['-jar', mars, 'nc', 'mc', getMemoryConfiguration(document.uri)];
  if (useDelayedBranching(document.uri)) {
    args.push('db');
  }

  if (mode === 'dumpText') {
    args.push('a', 'dump', '.text', 'HexText', path.join(cwd, getMachineCode(document.uri)), asm);
  } else if (mode === 'dumpKernel') {
    args.push('a', 'dump', '0x00004180-0x00004ffc', 'HexText', path.join(cwd, `${basenameNoExt(document.uri)}.kernel.txt`), asm);
  } else {
    args.push(asm);
  }

  const result = await runTool(java, args, {
    cwd,
    output: services.output,
    resource: document.uri
  });

  if (mode === 'run') {
    const outDir = vscode.Uri.file(path.join(cwd, '.co', 'out'));
    await ensureDirectory(outDir);
    const outFile = vscode.Uri.file(path.join(outDir.fsPath, `${basenameNoExt(document.uri)}.mars.out`));
    await writeTextFile(outFile, result.stdout);
  }

  if (result.ok) {
    if (mode === 'dumpText') {
      vscode.window.showInformationMessage(`MARS dumped ${getMachineCode(document.uri)}.`);
    } else if (mode === 'dumpKernel') {
      vscode.window.showInformationMessage('MARS dumped kernel text segment.');
    } else {
      vscode.window.showInformationMessage('MARS run completed.');
    }
  } else {
    vscode.window.showErrorMessage(`MARS failed${result.exitCode === null ? '' : ` with exit code ${result.exitCode}`}.`);
  }
}

