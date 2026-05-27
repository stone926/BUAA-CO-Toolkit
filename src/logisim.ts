import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getJava, getLogisimJar, getMachineCode } from './config';
import { dirname, readTextFile, writeTextFile, workspaceFolderFor } from './fsUtil';
import { runTool } from './process';
import { AppServices } from './types';

interface LogisimCircuit {
  name: string;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface LogisimComponent {
  name: string;
  label?: string;
  range: vscode.Range;
  selectionRange: vscode.Range;
}

interface LogisimParseResult {
  circuits: LogisimCircuit[];
  components: LogisimComponent[];
  diagnostics: vscode.Diagnostic[];
}

export function registerLogisim(context: vscode.ExtensionContext, services: AppServices): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('buaa-co-logisim');
  context.subscriptions.push(diagnostics);

  const refresh = (document: vscode.TextDocument) => {
    if (document.languageId === 'logisim-circ') {
      diagnostics.set(document.uri, parseLogisim(document).diagnostics);
    }
  };

  for (const document of vscode.workspace.textDocuments) {
    refresh(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.languages.registerDocumentSymbolProvider({ language: 'logisim-circ' }, new LogisimDocumentSymbolProvider()),
    vscode.languages.registerHoverProvider({ language: 'logisim-circ' }, new LogisimHoverProvider()),
    vscode.commands.registerCommand('co.logisim.generateRom', () => generateLogisimRom()),
    vscode.commands.registerCommand('co.logisim.convertLogToCsv', () => convertLogToCsv()),
    vscode.commands.registerCommand('co.logisim.openCurrentCircuit', () => openCurrentCircuit(services))
  );
}

class LogisimDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const parsed = parseLogisim(document);
    const symbols = parsed.circuits.map((circuit) => new vscode.DocumentSymbol(circuit.name, 'circuit', vscode.SymbolKind.Module, circuit.range, circuit.selectionRange));
    for (const component of parsed.components) {
      symbols.push(new vscode.DocumentSymbol(component.label ?? component.name, component.name, vscode.SymbolKind.Object, component.range, component.selectionRange));
    }
    return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
  }
}

class LogisimHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const parsed = parseLogisim(document);
    const circuit = parsed.circuits.find((item) => item.selectionRange.contains(position));
    if (circuit) {
      return new vscode.Hover(`Logisim circuit \`${circuit.name}\`.`);
    }
    const component = parsed.components.find((item) => item.selectionRange.contains(position) || item.range.contains(position));
    if (component) {
      return new vscode.Hover(`Component \`${component.name}\`${component.label ? ` labeled \`${component.label}\`` : ''}.`);
    }
    return undefined;
  }
}

function parseLogisim(document: vscode.TextDocument): LogisimParseResult {
  const text = document.getText();
  const circuits: LogisimCircuit[] = [];
  const components: LogisimComponent[] = [];
  const diagnostics: vscode.Diagnostic[] = [];

  if (!/<project\b/.test(text)) {
    diagnostics.push(makeDiagnostic(new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length)), 'This .circ file does not look like a Logisim project XML file.', vscode.DiagnosticSeverity.Warning, 'circ-project'));
  }

  const circuitRegex = /<circuit\b[^>]*\bname="([^"]+)"/g;
  let circuitMatch: RegExpExecArray | null;
  while ((circuitMatch = circuitRegex.exec(text))) {
    const name = circuitMatch[1];
    const offset = circuitMatch.index + circuitMatch[0].indexOf(name);
    circuits.push({
      name,
      range: rangeAtOffset(document, circuitMatch.index, circuitMatch[0].length),
      selectionRange: rangeAtOffset(document, offset, name.length)
    });
  }

  const componentRegex = /<comp\b[^>]*\bname="([^"]+)"[^>]*(?:\/>|>[\s\S]*?<\/comp>)/g;
  let componentMatch: RegExpExecArray | null;
  while ((componentMatch = componentRegex.exec(text))) {
    const block = componentMatch[0];
    const name = componentMatch[1];
    const labelMatch = block.match(/<a\b[^>]*\bname="label"[^>]*\bval="([^"]*)"/);
    const offset = componentMatch.index + componentMatch[0].indexOf(name);
    const component: LogisimComponent = {
      name,
      label: labelMatch?.[1],
      range: rangeAtOffset(document, componentMatch.index, block.length),
      selectionRange: rangeAtOffset(document, offset, name.length)
    };
    components.push(component);

    if (shouldLabelComponent(name) && !component.label) {
      diagnostics.push(makeDiagnostic(component.selectionRange, `Consider adding a label to ${name}; Logisim Logging is much easier to read with labels.`, vscode.DiagnosticSeverity.Information, 'missing-label'));
    }
    if ((name === 'ROM' || name === 'RAM' || name === 'Memory') && !/name="contents"/.test(block)) {
      diagnostics.push(makeDiagnostic(component.selectionRange, `${name} has no embedded contents. Remember to import a ROM file with 'v2.0 raw' when needed.`, vscode.DiagnosticSeverity.Information, 'memory-contents'));
    }
  }

  return {
    circuits,
    components,
    diagnostics
  };
}

async function generateLogisimRom(): Promise<void> {
  const input = await resolveMachineCodeInput();
  if (!input) {
    return;
  }
  const text = await readTextFile(input);
  const rom = normalizeLogisimRom(text);
  const defaultName = `${path.basename(input.fsPath, path.extname(input.fsPath))}.logisim.txt`;
  const output = vscode.Uri.file(path.join(path.dirname(input.fsPath), defaultName));
  await writeTextFile(output, rom);
  await vscode.window.showTextDocument(output);
  vscode.window.showInformationMessage(`Generated Logisim ROM file: ${path.basename(output.fsPath)}.`);
}

async function convertLogToCsv(): Promise<void> {
  const input = await resolveActiveOrPickedTextFile('Select Logisim logging text file');
  if (!input) {
    return;
  }
  const text = await readTextFile(input);
  const csv = logisimLogToCsv(text);
  const output = vscode.Uri.file(path.join(path.dirname(input.fsPath), `${path.basename(input.fsPath, path.extname(input.fsPath))}.csv`));
  await writeTextFile(output, csv);
  await vscode.window.showTextDocument(output);
}

async function openCurrentCircuit(services: AppServices): Promise<void> {
  const circuit = await resolveCircuitInput();
  if (!circuit) {
    return;
  }
  const logisim = getLogisimJar(circuit);
  if (!logisim) {
    vscode.window.showErrorMessage('Logisim jar is not configured. Set co.toolchain.logisim.');
    return;
  }
  if (!fs.existsSync(logisim)) {
    vscode.window.showErrorMessage(`Logisim jar does not exist: ${logisim}`);
    return;
  }
  services.output.show(true);
  const result = await runTool(getJava(circuit), ['-jar', logisim, circuit.fsPath], {
    cwd: dirname(circuit),
    output: services.output,
    resource: circuit
  });
  if (!result.ok) {
    vscode.window.showErrorMessage('Logisim exited with an error. Check the BUAA CO output panel.');
  }
}

async function resolveMachineCodeInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file' && path.basename(editor.document.uri.fsPath).toLowerCase() === getMachineCode(editor.document.uri).toLowerCase()) {
    return editor.document.uri;
  }
  const base = editor?.document.uri.scheme === 'file'
    ? path.dirname(editor.document.uri.fsPath)
    : workspaceFolderFor()?.uri.fsPath;
  if (base) {
    const candidate = path.join(base, getMachineCode(editor?.document.uri));
    if (fs.existsSync(candidate)) {
      return vscode.Uri.file(candidate);
    }
  }
  return await pickOneFile('Select MARS HexText machine code file', {
    Code: ['txt'],
    All: ['*']
  });
}

async function resolveActiveOrPickedTextFile(title: string): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === 'file') {
    return editor.document.uri;
  }
  return await pickOneFile(title, {
    Text: ['txt', 'log'],
    All: ['*']
  });
}

async function resolveCircuitInput(): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'logisim-circ' && editor.document.uri.scheme === 'file') {
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    return editor.document.uri;
  }
  return await pickOneFile('Select Logisim .circ file', {
    Logisim: ['circ']
  });
}

async function pickOneFile(title: string, filters: Record<string, string[]>): Promise<vscode.Uri | undefined> {
  const picked = await vscode.window.showOpenDialog({
    title,
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters
  });
  return picked?.[0];
}

function normalizeLogisimRom(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return 'v2.0 raw\n';
  }
  if (/^v2\.0\s+raw$/i.test(lines[0])) {
    return `${lines.join('\n')}\n`;
  }
  return `v2.0 raw\n${lines.join('\n')}\n`;
}

function logisimLogToCsv(text: string): string {
  const rows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/).map(csvEscape).join(','));
  return rows.join('\n') + (rows.length ? '\n' : '');
}

function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function shouldLabelComponent(name: string): boolean {
  return ['Pin', 'Register', 'ROM', 'RAM', 'Memory', 'Counter'].includes(name);
}

function makeDiagnostic(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, code: string): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = 'BUAA CO';
  diagnostic.code = code;
  return diagnostic;
}

function rangeAtOffset(document: vscode.TextDocument, offset: number, length: number): vscode.Range {
  return new vscode.Range(document.positionAt(offset), document.positionAt(offset + length));
}
