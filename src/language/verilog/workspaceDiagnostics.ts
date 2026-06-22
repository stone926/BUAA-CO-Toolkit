import {
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  VerilogModule,
  VerilogPortConnection,
  VerilogParseResult
} from './model';
import {
  shouldReportWidthMismatch,
  widthOfDecl,
  widthOfExpression
} from './parser';
import { getCachedVerilogParse } from './parseCache';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { VerilogToken } from './lexer';
import { parameterOverridesForInstance } from './parameterOverrides';

export function addVerilogWorkspaceDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  index: VerilogWorkspaceIndex,
  baseDiagnostics: Diagnostic[],
  parsed?: VerilogParseResult
): Diagnostic[] {
  const diagnostics = filterWorkspaceAwareDiagnostics(baseDiagnostics, settings, index);
  const resolved = parsed ?? getCachedVerilogParse(document, settings, false);
  diagnostics.push(...getWorkspaceInstanceDiagnostics(document, settings, index, resolved));
  diagnostics.push(...getWorkspaceProjectDiagnostics(document, settings, index, resolved));
  return diagnostics;
}

function filterWorkspaceAwareDiagnostics(diagnostics: Diagnostic[], settings: CoSettings, index: VerilogWorkspaceIndex): Diagnostic[] {
  const topName = settings.project.topModule.trim() || 'mips';
  if (!index.getModule(topName)) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) => diagnostic.code !== 'missing-top');
}

function getWorkspaceInstanceDiagnostics(document: TextDocument, settings: CoSettings, index: VerilogWorkspaceIndex, parsed: VerilogParseResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
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
        const expected = widthOfDecl(targetPort, target, parameterOverridesForInstance(instance, module, target));
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

function getWorkspaceProjectDiagnostics(document: TextDocument, settings: CoSettings, index: VerilogWorkspaceIndex, parsed: VerilogParseResult): Diagnostic[] {
  if (!settings.verilog.lint.courseRules) {
    return [];
  }
  const profile = settings.project.profile;
  if (profile !== 'P4' && profile !== 'P5' && profile !== 'P6' && profile !== 'P7') {
    return [];
  }

  const topName = settings.project.topModule.trim() || 'mips';
  const top = parsed.modules.find((module) => module.name === topName);
  if (!top) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const topRange = top.selectionRange;

  if (profile === 'P4' || profile === 'P5') {
    if (!hasWorkspaceNumericValue(index, 0x3000)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: PC should reset to 0x00003000; no obvious 0x3000 reset constant was found in the workspace.`, DiagnosticSeverity.Information, 'project-pc-reset'));
    }
    if (!hasMemoryDepth(index, 4096)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: IM is expected to be 16 KiB (4096 32-bit words).`, DiagnosticSeverity.Information, 'project-im-size'));
    }
    if (!hasMemoryDepth(index, 3072)) {
      diagnostics.push(makeDiagnostic(topRange, `${profile}: DM is expected to be 12 KiB (3072 32-bit words).`, DiagnosticSeverity.Information, 'project-dm-size'));
    }
  }

  if (profile === 'P7') {
    for (const required of ['CPU', 'Bridge', 'TC']) {
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
    if (!hasWorkspaceNumericValue(index, 0x4180)) {
      diagnostics.push(makeDiagnostic(topRange, 'P7: exception entry address should be 0x00004180; no obvious 0x4180 constant was found in the workspace.', DiagnosticSeverity.Warning, 'p7-exception-entry'));
    }
  }

  return diagnostics;
}

function hasWorkspaceNumericValue(index: VerilogWorkspaceIndex, expected: number): boolean {
  for (const file of index.indexedFiles()) {
    for (const token of file.cst.codeTokens) {
      if (token.kind === 'number' && numericTokenValue(token) === BigInt(expected)) {
        return true;
      }
    }
  }
  return false;
}

function hasMemoryDepth(index: VerilogWorkspaceIndex, depth: number): boolean {
  const last = depth - 1;
  for (const file of index.indexedFiles()) {
    const tokens = file.cst.codeTokens;
    for (let index = 0; index + 4 < tokens.length; index++) {
      if (
        tokens[index].value === '[' &&
        tokens[index + 2].value === ':' &&
        tokens[index + 4].value === ']' &&
        bracketBoundsMatch(tokens[index + 1], tokens[index + 3], last)
      ) {
        return true;
      }
    }
  }
  return false;
}

function bracketBoundsMatch(left: VerilogToken, right: VerilogToken, last: number): boolean {
  const leftValue = numericTokenValue(left);
  const rightValue = numericTokenValue(right);
  return (leftValue === 0n && rightValue === BigInt(last)) ||
    (leftValue === BigInt(last) && rightValue === 0n);
}

function numericTokenValue(token: VerilogToken): bigint | undefined {
  if (token.kind !== 'number') {
    return undefined;
  }
  const parsed = parseVerilogNumber(token.value);
  if (!parsed) {
    return undefined;
  }
  const radix = parsed.base === 'b' ? 2n : parsed.base === 'o' ? 8n : parsed.base === 'h' ? 16n : 10n;
  let value = 0n;
  for (const char of parsed.digits) {
    if (char === '_') {
      continue;
    }
    const digit = digitValue(char);
    if (digit === undefined || BigInt(digit) >= radix) {
      return undefined;
    }
    value = value * radix + BigInt(digit);
  }
  return value;
}

function parseVerilogNumber(value: string): { base: 'b' | 'o' | 'd' | 'h'; digits: string } | undefined {
  const apostrophe = value.indexOf("'");
  if (apostrophe < 0) {
    return allDecimalDigits(value) ? { base: 'd', digits: value } : undefined;
  }
  let index = apostrophe + 1;
  if (value[index] === 's' || value[index] === 'S') {
    index++;
  }
  const base = value[index]?.toLowerCase();
  if (base !== 'b' && base !== 'o' && base !== 'd' && base !== 'h') {
    return undefined;
  }
  const digits = value.slice(index + 1);
  return digits ? { base, digits } : undefined;
}

function allDecimalDigits(value: string): boolean {
  let sawDigit = false;
  for (const char of value) {
    if (char === '_') {
      continue;
    }
    if (char < '0' || char > '9') {
      return false;
    }
    sawDigit = true;
  }
  return sawDigit;
}

function digitValue(char: string): number | undefined {
  if (char >= '0' && char <= '9') {
    return char.charCodeAt(0) - '0'.charCodeAt(0);
  }
  const lower = char.toLowerCase();
  if (lower >= 'a' && lower <= 'f') {
    return lower.charCodeAt(0) - 'a'.charCodeAt(0) + 10;
  }
  return undefined;
}

function hasModuleCaseInsensitive(index: VerilogWorkspaceIndex, name: string): boolean {
  return Boolean(index.findModuleCaseInsensitive(name));
}

function findModuleCaseInsensitive(index: VerilogWorkspaceIndex, name: string): VerilogModule | undefined {
  return index.findModuleCaseInsensitive(name);
}

function hasInstanceOfModuleCaseInsensitive(index: VerilogWorkspaceIndex, moduleName: string): boolean {
  return index.hasInstanceOfModuleCaseInsensitive(moduleName);
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
