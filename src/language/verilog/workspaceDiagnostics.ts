import {
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  VerilogModule,
  VerilogPortConnection
} from './model';
import {
  parseVerilog,
  shouldReportWidthMismatch,
  stripCommentsAndStrings,
  widthOfDecl,
  widthOfExpression
} from './parser';
import { VerilogWorkspaceIndex } from './workspaceIndex';

export function addVerilogWorkspaceDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  index: VerilogWorkspaceIndex,
  baseDiagnostics: Diagnostic[]
): Diagnostic[] {
  const diagnostics = filterWorkspaceAwareDiagnostics(baseDiagnostics, settings, index);
  diagnostics.push(...getWorkspaceInstanceDiagnostics(document, settings, index));
  diagnostics.push(...getWorkspaceProjectDiagnostics(document, settings, index));
  return diagnostics;
}

function filterWorkspaceAwareDiagnostics(diagnostics: Diagnostic[], settings: CoSettings, index: VerilogWorkspaceIndex): Diagnostic[] {
  const topName = settings.project.topModule.trim() || 'mips';
  if (!index.getModule(topName)) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => diagnostic.code !== 'missing-top');
}

function getWorkspaceInstanceDiagnostics(document: TextDocument, settings: CoSettings, index: VerilogWorkspaceIndex): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseVerilog(document, settings, false);
  for (const module of parsed.modules) {
    for (const instance of module.instances) {
      const target = index.getModule(instance.moduleName);
      if (!target || target.uri === document.uri) {
        continue;
      }
      const targetPorts = new Map(target.ports.map((port) => [port.name, port]));
      const seenConnections = new Map<string, VerilogPortConnection>();
      for (const connection of instance.portConnections) {
        const targetPort = connection.name
          ? targetPorts.get(connection.name)
          : target.ports[connection.positionalIndex];
        if (connection.name) {
          const previous = seenConnections.get(connection.name);
          if (previous) {
            diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Port '${connection.name}' is connected more than once.`, DiagnosticSeverity.Warning, 'duplicate-port-connection'));
            continue;
          }
          seenConnections.set(connection.name, connection);
          if (!targetPort) {
            diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Module '${target.name}' has no port named '${connection.name}'.`, DiagnosticSeverity.Error, 'unknown-port'));
            continue;
          }
        }
        if (!targetPort || !connection.expression.trim()) {
          continue;
        }
        const expected = widthOfDecl(targetPort);
        const actual = widthOfExpression(connection.expression, module);
        if (shouldReportWidthMismatch(expected, actual)) {
          diagnostics.push(makeDiagnostic(
            connection.expressionRange,
            `Port '${targetPort.name}' is ${expected.width} bit(s), but this connection is ${actual.width} bit(s).`,
            DiagnosticSeverity.Warning,
            'port-width-mismatch'
          ));
        }
      }
      if (instance.portConnections.some((connection) => connection.name)) {
        for (const port of target.ports) {
          if (!seenConnections.has(port.name)) {
            diagnostics.push(makeDiagnostic(instance.selectionRange, `Instance '${instance.instanceName}' does not connect port '${port.name}'.`, DiagnosticSeverity.Information, `missing-port:${port.name}`));
          }
        }
      }
    }
  }
  return diagnostics;
}

function getWorkspaceProjectDiagnostics(document: TextDocument, settings: CoSettings, index: VerilogWorkspaceIndex): Diagnostic[] {
  if (!settings.verilog.lint.courseRules) {
    return [];
  }
  const profile = settings.project.profile;
  if (profile !== 'P4' && profile !== 'P5' && profile !== 'P6' && profile !== 'P7') {
    return [];
  }

  const parsed = parseVerilog(document, settings, false);
  const topName = settings.project.topModule.trim() || 'mips';
  const top = parsed.modules.find((module) => module.name === topName);
  if (!top) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const workspaceText = index.allFiles().map((file) => file.text).join('\n');
  const workspaceCode = stripCommentsAndStrings(workspaceText);
  const topRange = top.selectionRange;

  if (profile === 'P4' || profile === 'P5') {
    if (!hasPcResetAddress(workspaceCode)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: PC should reset to 0x00003000; no obvious 0x3000 reset constant was found in the workspace.`, DiagnosticSeverity.Information, 'project-pc-reset'));
    }
    if (!hasMemoryDepth(workspaceCode, 4096)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: IM is expected to be 16 KiB (4096 32-bit words).`, DiagnosticSeverity.Information, 'project-im-size'));
    }
    if (!hasMemoryDepth(workspaceCode, 3072)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: DM is expected to be 12 KiB (3072 32-bit words).`, DiagnosticSeverity.Information, 'project-dm-size'));
    }
  }

  if (profile === 'P7') {
    for (const required of ['CPU', 'Bridge', 'Timer0', 'Timer1']) {
      if (!hasModuleCaseInsensitive(index, required)) {
        diagnostics.push(makeDiagnostic(topRange, `P7: workspace should contain module '${required}'.`, DiagnosticSeverity.Warning, `p7-module-${required.toLowerCase()}`));
      } else if (!hasInstanceOfModuleCaseInsensitive(index, required) && required.toLowerCase() !== top.name.toLowerCase()) {
        diagnostics.push(makeDiagnostic(topRange, `P7: module '${required}' exists but is not obviously instantiated in the design hierarchy.`, DiagnosticSeverity.Information, `p7-instance-${required.toLowerCase()}`));
      }
    }
    const cp0 = findModuleCaseInsensitive(index, 'CP0');
    if (!cp0) {
      diagnostics.push(makeDiagnostic(topRange, 'P7: workspace should contain a CP0 module.', DiagnosticSeverity.Warning, 'p7-module-cp0'));
    } else {
      for (const registerName of ['SR', 'CAUSE', 'EPC']) {
        if (!hasDeclarationCaseInsensitive(cp0, registerName)) {
          diagnostics.push(makeDiagnostic(topRange, `P7: CP0 should implement register '${registerName}'.`, DiagnosticSeverity.Warning, `p7-cp0-${registerName.toLowerCase()}`));
        }
      }
    }
    if (!hasExceptionEntry(workspaceCode)) {
      diagnostics.push(makeDiagnostic(topRange, 'P7: exception entry address should be 0x00004180; no obvious 0x4180 constant was found in the workspace.', DiagnosticSeverity.Warning, 'p7-exception-entry'));
    }
  }

  return diagnostics;
}

function hasPcResetAddress(code: string): boolean {
  return /(?:\d+\s*'\s*h\s*0*3000\b|\b0x0*3000\b|\b12288\b)/i.test(code);
}

function hasExceptionEntry(code: string): boolean {
  return /(?:\d+\s*'\s*h\s*0*4180\b|\b0x0*4180\b|\b16768\b)/i.test(code);
}

function hasMemoryDepth(code: string, depth: number): boolean {
  const last = depth - 1;
  const pattern = new RegExp(`\\[\\s*(?:0\\s*:\\s*${last}|${last}\\s*:\\s*0)\\s*\\]`);
  return pattern.test(code);
}

function hasModuleCaseInsensitive(index: VerilogWorkspaceIndex, name: string): boolean {
  return Boolean(findModuleCaseInsensitive(index, name));
}

function findModuleCaseInsensitive(index: VerilogWorkspaceIndex, name: string): VerilogModule | undefined {
  const lower = name.toLowerCase();
  return index.allModules().find((module) => module.name.toLowerCase() === lower);
}

function hasInstanceOfModuleCaseInsensitive(index: VerilogWorkspaceIndex, moduleName: string): boolean {
  const lower = moduleName.toLowerCase();
  return index.allModules().some((module) => module.instances.some((instance) => instance.moduleName.toLowerCase() === lower));
}

function hasDeclarationCaseInsensitive(module: VerilogModule, name: string): boolean {
  const lower = name.toLowerCase();
  for (const declaration of module.declarations.values()) {
    if (declaration.name.toLowerCase() === lower) {
      return true;
    }
  }
  return false;
}
