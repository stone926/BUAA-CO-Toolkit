import {
  Diagnostic,
  DiagnosticSeverity
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  VerilogInstance,
  VerilogModule,
  VerilogParseResult
} from './model';
import { getCachedVerilogParse } from './parseCache';
import { VerilogWorkspaceIndex } from './workspaceIndex';
import { VerilogToken } from './lexer';
import { collectInstanceConnectionDiagnostics } from './instanceConnectionDiagnostics';
import { collectWorkspaceDriverDiagnostics } from './driverDiagnostics';
import { collectWorkspaceUsageDiagnostics } from './usageDiagnostics';

export function addVerilogWorkspaceDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  index: VerilogWorkspaceIndex,
  baseDiagnostics: Diagnostic[],
  parsed?: VerilogParseResult
): Diagnostic[] {
  const diagnostics = filterWorkspaceAwareDiagnostics(baseDiagnostics, settings, index);
  const resolved = parsed ?? getCachedVerilogParse(document, settings, false);
  diagnostics.push(...getWorkspaceModuleDiagnostics(document, settings, index, resolved));
  diagnostics.push(...getWorkspaceInstanceDiagnostics(document, settings, index, resolved));
  if (settings.verilog.lint.courseRules) {
    diagnostics.push(...collectWorkspaceDriverDiagnostics(document, resolved, index));
    diagnostics.push(...collectWorkspaceUsageDiagnostics(document, settings, resolved, index));
  }
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
      const target = resolveInstanceTarget(index, parsed.modules, instance);
      if (!target || target.uri === document.uri) {
        continue;
      }
      collectInstanceConnectionDiagnostics(document, module, instance, target, diagnostics);
    }
  }
  return diagnostics;
}

function getWorkspaceModuleDiagnostics(document: TextDocument, settings: CoSettings, index: VerilogWorkspaceIndex, parsed: VerilogParseResult): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const topName = settings.project.topModule.trim() || 'mips';
  const testbenchName = settings.project.testbench.trim();
  for (const module of parsed.modules) {
    const duplicates = index.getModules(module.name).filter((candidate) => candidate.uri !== module.uri);
    if (duplicates.length) {
      diagnostics.push(makeDiagnostic(
        module.selectionRange,
        `Duplicate module '${module.name}'. Another definition exists in ${formatModuleLocation(duplicates[0])}.`,
        DiagnosticSeverity.Error,
        'duplicate-module'
      ));
    }
    if (
      settings.verilog.lint.courseRules &&
      module.name !== topName &&
      module.name !== testbenchName &&
      !hasInstanceOfModule(index, parsed.modules, module.name)
    ) {
      diagnostics.push(makeDiagnostic(
        module.selectionRange,
        `Module '${module.name}' is not instantiated by any indexed module.`,
        DiagnosticSeverity.Information,
        'uninstantiated-module'
      ));
    }
  }

  for (const module of parsed.modules) {
    for (const instance of module.instances) {
      if (!resolveInstanceTarget(index, parsed.modules, instance) && !isBuiltinPrimitive(instance.moduleName)) {
        diagnostics.push(makeDiagnostic(
          instance.moduleSelectionRange,
          `Module '${instance.moduleName}' is not defined in the workspace.`,
          DiagnosticSeverity.Error,
          'unresolved-module'
        ));
      }
    }
  }
  return diagnostics;
}

function resolveInstanceTarget(index: VerilogWorkspaceIndex, localModules: VerilogModule[], instance: VerilogInstance): VerilogModule | undefined {
  return index.getModule(instance.moduleName) ?? localModules.find((module) => module.name === instance.moduleName);
}

function hasInstanceOfModule(index: VerilogWorkspaceIndex, localModules: VerilogModule[], moduleName: string): boolean {
  return [...index.indexedModules(), ...localModules].some((module) =>
    module.instances.some((instance) => instance.moduleName === moduleName)
  );
}

function formatModuleLocation(module: VerilogModule): string {
  return `${formatUri(module.uri)}:${module.selectionRange.start.line + 1}`;
}

function formatUri(uri: string): string {
  try {
    return URI.parse(uri).fsPath || uri;
  } catch {
    return uri;
  }
}

const builtinPrimitives = new Set([
  'and',
  'nand',
  'or',
  'nor',
  'xor',
  'xnor',
  'buf',
  'not',
  'bufif0',
  'bufif1',
  'notif0',
  'notif1',
  'pulldown',
  'pullup',
  'nmos',
  'pmos',
  'rnmos',
  'rpmos',
  'cmos',
  'rcmos',
  'tran',
  'rtran',
  'tranif0',
  'tranif1',
  'rtranif0',
  'rtranif1'
]);

function isBuiltinPrimitive(name: string): boolean {
  return builtinPrimitives.has(name);
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
