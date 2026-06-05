import * as path from 'path';
import * as vscode from 'vscode';
import {
  getJava,
  getMachineCode,
  getMarsJar,
  getMemoryConfiguration,
  getMipsExtraArgs,
  useDelayedBranching
} from './config';
import { basenameNoExt, dirname, ensureDirectory, writeTextFile } from './fsUtil';
import { commandLine, runTool } from './process';
import { AppServices, RunResult } from './types';
import { pickOneFile } from './workflowInputs';

export type MarsRunMode = 'run' | 'dumpText' | 'dumpKernel';

export interface MarsRunOptions {
  showMessages?: boolean;
  stdin?: string;
  stdinSource?: vscode.Uri;
}

export interface MarsRunOutput {
  result: RunResult;
  outputFile?: vscode.Uri;
}

export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.mips.disablePseudoWarnings', async () => {
      await vscode.workspace.getConfiguration('co').update('mips.warnPseudoInstruction', false, vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage('Disabled MIPS pseudo-instruction warnings in this workspace.');
    }),
    vscode.commands.registerCommand('co.mips.runCurrentFile', () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand('co.mips.runAndCapture', () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand('co.mips.runWithStdinFile', () => runMarsCurrentFileWithStdinFile(services)),
    vscode.commands.registerCommand('co.mips.runInTerminal', () => runMarsCurrentFileInTerminal()),
    vscode.commands.registerCommand('co.mips.dumpText', () => runMarsCurrentFile(services, 'dumpText')),
    vscode.commands.registerCommand('co.mips.dumpKernelText', () => runMarsCurrentFile(services, 'dumpKernel'))
  );
}

async function resolveCurrentMipsDocument(): Promise<vscode.TextDocument | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'mipsasm') {
    vscode.window.showErrorMessage('Open a MIPS ASM file first.');
    return undefined;
  }
  const document = editor.document;
  if (document.isUntitled) {
    vscode.window.showErrorMessage('Save the ASM file before running MARS.');
    return undefined;
  }
  if (document.isDirty) {
    await document.save();
  }
  return document;
}

async function runMarsCurrentFile(services: AppServices, mode: MarsRunMode): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) { return; }

  await runMarsFile(services, document.uri, mode);
}

async function runMarsCurrentFileWithStdinFile(services: AppServices): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) { return; }

  const stdinSource = await pickOneFile('Select stdin text file for MARS', {
    Text: ['txt', 'in', 'input', 'dat'],
    All: ['*']
  });
  if (!stdinSource) {
    return;
  }
  const bytes = await vscode.workspace.fs.readFile(stdinSource);
  await runMarsFile(services, document.uri, 'run', {
    stdin: Buffer.from(bytes).toString('utf8'),
    stdinSource
  });
}

async function runMarsCurrentFileInTerminal(): Promise<void> {
  const document = await resolveCurrentMipsDocument();
  if (!document) { return; }

  const mars = getMarsJar(document.uri);
  if (!mars) {
    vscode.window.showErrorMessage('MARS jar is not configured. Set co.toolchain.mars or co.toolchain.marsP7.');
    return;
  }

  const java = getJava(document.uri);
  const cwd = dirname(document.uri);
  const args = buildMarsArgs(document.uri, mars, 'run');
  const terminal = vscode.window.createTerminal({
    name: `MARS: ${path.basename(document.uri.fsPath)}`,
    cwd
  });
  terminal.show();
  terminal.sendText(commandLine(java, args), true);
}

export async function runMarsFile(
  services: AppServices,
  asmUri: vscode.Uri,
  mode: MarsRunMode,
  options: MarsRunOptions = {}
): Promise<MarsRunOutput | undefined> {
  const showMessages = options.showMessages !== false;
  const mars = getMarsJar(asmUri);
  if (!mars) {
    vscode.window.showErrorMessage('MARS jar is not configured. Set co.toolchain.mars or co.toolchain.marsP7.');
    return undefined;
  }

  services.output.show(true);
  const java = getJava(asmUri);
  const cwd = dirname(asmUri);
  const args = buildMarsArgs(asmUri, mars, mode);

  let outputFile: vscode.Uri | undefined;
  if (mode === 'dumpText') {
    outputFile = vscode.Uri.file(path.join(cwd, getMachineCode(asmUri)));
    args.push('a', 'dump', '.text', 'HexText', outputFile.fsPath, asmUri.fsPath);
  } else if (mode === 'dumpKernel') {
    outputFile = vscode.Uri.file(path.join(cwd, `${basenameNoExt(asmUri)}.kernel.txt`));
    args.push('a', 'dump', '0x00004180-0x00004ffc', 'HexText', outputFile.fsPath, asmUri.fsPath);
  }

  const result = await runTool(java, args, {
    cwd,
    output: services.output,
    resource: asmUri,
    stdin: options.stdin
  });

  if (mode === 'run') {
    const outDir = vscode.Uri.file(path.join(cwd, '.co', 'out'));
    await ensureDirectory(outDir);
    outputFile = vscode.Uri.file(path.join(outDir.fsPath, marsOutputFileName(asmUri, options.stdinSource)));
    await writeTextFile(outputFile, result.stdout);
  }

  if (!showMessages) {
    return { result, outputFile };
  }

  if (result.ok) {
    if (mode === 'dumpText') {
      vscode.window.showInformationMessage(`MARS dumped ${getMachineCode(asmUri)}.`);
    } else if (mode === 'dumpKernel') {
      vscode.window.showInformationMessage('MARS dumped kernel text segment.');
    } else {
      const input = options.stdinSource ? ` with stdin ${path.basename(options.stdinSource.fsPath)}` : '';
      vscode.window.showInformationMessage(`MARS run completed${input}.`);
    }
  } else {
    vscode.window.showErrorMessage(`MARS failed${result.exitCode === null ? '' : ` with exit code ${result.exitCode}`}.`);
  }

  return { result, outputFile };
}

function marsOutputFileName(asmUri: vscode.Uri, stdinSource?: vscode.Uri): string {
  const asmName = basenameNoExt(asmUri);
  if (!stdinSource) {
    return `${asmName}.mars.out`;
  }
  const inputName = path.basename(stdinSource.fsPath, path.extname(stdinSource.fsPath));
  return `${asmName}.${sanitizeFileStem(inputName)}.mars.out`;
}

function buildMarsArgs(asmUri: vscode.Uri, mars: string, mode: MarsRunMode): string[] {
  const args = ['-jar', mars, 'nc', 'mc', getMemoryConfiguration(asmUri)];
  if (useDelayedBranching(asmUri)) {
    args.push('db');
  }
  args.push(...getMipsExtraArgs(asmUri));
  if (mode === 'run') {
    args.push(asmUri.fsPath);
  }
  return args;
}

function sanitizeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'stdin';
}
