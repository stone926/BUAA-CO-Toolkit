import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  config,
  getIsePath,
  getProfile,
  getSimTime,
  getTestbench,
  getTopModule
} from './config';
import { CoSettings, defaultCoSettings } from './language/common/settings';
import {
  buildTestbench,
  moduleAtPosition,
  parseVerilog
} from './language/verilog/service';
import { ensureDirectory, workspaceFolderFor, writeTextFile } from './fsUtil';
import { runTool } from './process';
import { findFuse } from './toolchain';
import { AppServices } from './types';

export function registerVerilog(context: vscode.ExtensionContext, services: AppServices): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('co.verilog.disableLintRule', (rule?: string) => disableLintRule(rule)),
    vscode.commands.registerCommand('co.verilog.generateTestbench', () => generateTestbench()),
    vscode.commands.registerCommand('co.verilog.generateIseProject', () => generateIseProject(services)),
    vscode.commands.registerCommand('co.verilog.runIsim', () => runIsim(services))
  );
}

async function disableLintRule(rule?: string): Promise<void> {
  const normalized = normalizeLintRule(rule);
  if (!normalized) {
    vscode.window.showErrorMessage('Cannot disable this Verilog lint rule because its rule id is invalid.');
    return;
  }
  const config = vscode.workspace.getConfiguration('co');
  const current = config.get<string[]>('verilog.lint.disabledRules', defaultCoSettings.verilog.lint.disabledRules);
  const merged = [...new Set([...current.map((item) => item.toLowerCase()), normalized])].sort();
  await config.update('verilog.lint.disabledRules', merged, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Disabled ${normalized.toUpperCase()} in this workspace.`);
}

async function generateTestbench(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'verilog') {
    vscode.window.showErrorMessage('Open a Verilog file first.');
    return;
  }
  const document = toTextDocument(editor.document);
  const parsed = parseVerilog(document, coSettingsForUri(editor.document.uri), false);
  const target = moduleAtPosition(parsed.modules, {
    line: editor.selection.active.line,
    character: editor.selection.active.character
  }) ?? parsed.modules[0];
  if (!target) {
    vscode.window.showErrorMessage('No Verilog module found in the current file.');
    return;
  }

  const configuredTb = getTestbench(editor.document.uri);
  const tbName = target.name === getTopModule(editor.document.uri) ? configuredTb : `${target.name}_tb`;
  const tbUri = vscode.Uri.file(path.join(path.dirname(editor.document.uri.fsPath), `${tbName}.v`));
  if (fs.existsSync(tbUri.fsPath)) {
    const choice = await vscode.window.showWarningMessage(`${path.basename(tbUri.fsPath)} already exists.`, 'Open', 'Overwrite');
    if (choice === 'Open') {
      await vscode.window.showTextDocument(tbUri);
      return;
    }
    if (choice !== 'Overwrite') {
      return;
    }
  }
  await writeTextFile(tbUri, buildTestbench(target, tbName));
  await vscode.window.showTextDocument(tbUri);
}

async function generateIseProject(services: AppServices): Promise<{ prj: vscode.Uri; tcl: vscode.Uri; outDir: vscode.Uri } | undefined> {
  const folder = workspaceFolderFor(vscode.window.activeTextEditor?.document.uri);
  if (!folder) {
    vscode.window.showErrorMessage('Open a workspace folder before generating ISE files.');
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const top = getTestbench(activeUri);
  const simTime = getSimTime(activeUri);
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.v'), '**/{node_modules,out,.git}/**', 5000);
  if (!files.length) {
    vscode.window.showErrorMessage('No Verilog files found in the workspace.');
    return undefined;
  }

  const outDir = vscode.Uri.file(path.join(folder.uri.fsPath, '.co', 'isim'));
  await ensureDirectory(outDir);
  const prj = vscode.Uri.file(path.join(outDir.fsPath, `${top}.prj`));
  const tcl = vscode.Uri.file(path.join(outDir.fsPath, `${top}.tcl`));
  const prjText = files
    .map((uri) => `Verilog work "${uri.fsPath.replace(/\\/g, '/')}"`)
    .sort()
    .join('\n') + '\n';
  const tclText = `run ${simTime};\nexit\n`;
  await writeTextFile(prj, prjText);
  await writeTextFile(tcl, tclText);
  services.output.appendLine(`Generated ${prj.fsPath}`);
  services.output.appendLine(`Generated ${tcl.fsPath}`);
  vscode.window.showInformationMessage('Generated ISE PRJ/TCL files.');
  return { prj, tcl, outDir };
}

async function runIsim(services: AppServices): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const isePath = getIsePath(activeUri);
  if (!isePath) {
    vscode.window.showErrorMessage('ISE path is not configured. Set co.toolchain.isePath.');
    return;
  }
  const fuse = findFuse(isePath);
  if (!fs.existsSync(fuse)) {
    vscode.window.showErrorMessage(`Cannot find fuse executable: ${fuse}`);
    return;
  }
  const generated = await generateIseProject(services);
  if (!generated) {
    return;
  }
  const top = getTestbench(activeUri);
  const exeName = process.platform === 'win32' ? `${top}.exe` : top;
  services.output.show(true);
  const fuseResult = await runTool(fuse, ['-nodebug', '-prj', path.basename(generated.prj.fsPath), '-o', exeName, top], {
    cwd: generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: {
      XILINX: isePath
    }
  });
  if (!fuseResult.ok) {
    vscode.window.showErrorMessage('ISim compile failed. Check the BUAA CO output panel.');
    return;
  }
  const exePath = path.join(generated.outDir.fsPath, exeName);
  const simResult = await runTool(exePath, ['-nolog', '-tclbatch', path.basename(generated.tcl.fsPath)], {
    cwd: generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: {
      XILINX: isePath
    }
  });
  if (simResult.ok) {
    const out = vscode.Uri.file(path.join(generated.outDir.fsPath, `${top}.sim.out`));
    await writeTextFile(out, simResult.stdout);
    vscode.window.showInformationMessage('ISim run completed.');
  } else {
    vscode.window.showErrorMessage('ISim run failed. Check the BUAA CO output panel.');
  }
}

function toTextDocument(document: vscode.TextDocument): TextDocument {
  return TextDocument.create(document.uri.toString(), document.languageId, document.version, document.getText());
}

function coSettingsForUri(uri: vscode.Uri): CoSettings {
  return {
    ...defaultCoSettings,
    project: {
      ...defaultCoSettings.project,
      profile: getProfile(uri),
      topModule: getTopModule(uri),
      testbench: getTestbench(uri),
      simTime: getSimTime(uri)
    },
    verilog: {
      implicitNet: {
        diagnostic: config<CoSettings['verilog']['implicitNet']['diagnostic']>('verilog.implicitNet.diagnostic', defaultCoSettings.verilog.implicitNet.diagnostic, uri),
        ignorePatterns: config<string[]>('verilog.implicitNet.ignorePatterns', defaultCoSettings.verilog.implicitNet.ignorePatterns, uri)
      },
      lint: {
        courseRules: config<boolean>('verilog.lint.courseRules', defaultCoSettings.verilog.lint.courseRules, uri),
        synthesizableHints: config<boolean>('verilog.lint.synthesizableHints', defaultCoSettings.verilog.lint.synthesizableHints, uri),
        disabledRules: config<string[]>('verilog.lint.disabledRules', defaultCoSettings.verilog.lint.disabledRules, uri)
      },
      format: {
        style: config<CoSettings['verilog']['format']['style']>('verilog.format.style', defaultCoSettings.verilog.format.style, uri),
        continuationIndent: config<number>('verilog.format.continuationIndent', defaultCoSettings.verilog.format.continuationIndent, uri),
        spaceInRange: config<boolean>('verilog.format.spaceInRange', defaultCoSettings.verilog.format.spaceInRange, uri),
        declarationRangeSpacing: config<CoSettings['verilog']['format']['declarationRangeSpacing']>('verilog.format.declarationRangeSpacing', defaultCoSettings.verilog.format.declarationRangeSpacing, uri),
        spaceBeforeInstancePorts: config<boolean>('verilog.format.spaceBeforeInstancePorts', defaultCoSettings.verilog.format.spaceBeforeInstancePorts, uri),
        separateElse: config<boolean>('verilog.format.separateElse', defaultCoSettings.verilog.format.separateElse, uri),
        maxBlankLines: config<number>('verilog.format.maxBlankLines', defaultCoSettings.verilog.format.maxBlankLines, uri)
      }
    }
  };
}

function normalizeLintRule(rule?: string): string | undefined {
  const normalized = rule?.trim().toLowerCase();
  return normalized && /^vc-\d{3}$/.test(normalized) ? normalized : undefined;
}
