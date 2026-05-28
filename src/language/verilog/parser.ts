import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ProjectProfile } from '../../projectProfile';
import { containsPosition, lineAt, makeDiagnostic, rangeAtOffset } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  expectedPorts,
  systemTasks,
  VerilogDecl,
  VerilogDeclKind,
  VerilogInstance,
  VerilogMacro,
  VerilogModule,
  VerilogParseResult,
  verilogKeywords
} from './model';

export function parseVerilog(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const text = document.getText();
  const modules = parseModules(document, text);
  const macros = parseMacros(document, text);
  const diagnostics = includeDiagnostics ? collectVerilogDiagnostics(document, settings, text, modules) : [];
  return {
    modules,
    macros,
    diagnostics
  };
}

export function parseModules(document: TextDocument, text: string): VerilogModule[] {
  const modules: VerilogModule[] = [];
  const moduleRegex = /\bmodule\s+([A-Za-z_]\w*)\s*(?:#\s*\(([\s\S]*?)\)\s*)?\(([\s\S]*?)\)\s*;/g;
  let match: RegExpExecArray | null;
  while ((match = moduleRegex.exec(text))) {
    const name = match[1];
    const header = match[3] ?? '';
    const bodyStartOffset = match.index + match[0].length;
    const endOffset = findEndmodule(text, bodyStartOffset);
    const nameOffset = match.index + match[0].indexOf(name);
    const module: VerilogModule = {
      name,
      ports: [],
      declarations: new Map(),
      instances: [],
      range: Range.create(document.positionAt(match.index), document.positionAt(endOffset)),
      selectionRange: Range.create(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length)),
      headerEnd: document.positionAt(bodyStartOffset),
      uri: document.uri,
      bodyText: text.slice(bodyStartOffset, endOffset)
    };
    for (const port of parseHeaderPorts(document, text, header, match.index)) {
      module.ports.push(port);
      module.declarations.set(port.name, port);
    }
    for (const decl of parseDeclarations(document, text, bodyStartOffset, endOffset)) {
      const existing = module.declarations.get(decl.name);
      if (existing && (decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'inout')) {
        const merged = {
          ...existing,
          ...decl,
          direction: decl.kind
        };
        module.declarations.set(decl.name, merged);
        const portIndex = module.ports.findIndex((port) => port.name === decl.name);
        if (portIndex >= 0) {
          module.ports[portIndex] = merged;
        }
      } else {
        module.declarations.set(decl.name, decl);
        if (decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'inout') {
          module.ports.push({
            ...decl,
            direction: decl.kind
          });
        }
      }
    }
    module.instances = parseInstances(document, text, bodyStartOffset, endOffset, module.name);
    modules.push(module);
  }
  return modules;
}

export function parseMacros(document: TextDocument, text: string): VerilogMacro[] {
  const macros: VerilogMacro[] = [];
  const macroRegex = /^\s*`define\s+([A-Za-z_]\w*)/gm;
  let match: RegExpExecArray | null;
  while ((match = macroRegex.exec(text))) {
    const offset = match.index + match[0].indexOf(match[1]);
    macros.push({
      name: match[1],
      range: lineAt(document, document.positionAt(offset).line).range,
      selectionRange: Range.create(document.positionAt(offset), document.positionAt(offset + match[1].length))
    });
  }
  return macros;
}

export function moduleAtPosition(modules: VerilogModule[], position: Position): VerilogModule | undefined {
  return modules.find((module) => containsPosition(module.range, position));
}

export function declDetail(decl: VerilogDecl): string {
  return `${decl.direction ?? decl.kind} ${decl.width ? `${decl.width} ` : ''}${decl.name}`.trim();
}

export function buildTestbench(module: VerilogModule, tbName: string): string {
  const declarations = module.ports.map((port) => {
    const kind = port.direction === 'input' || port.direction === 'inout' ? 'reg' : 'wire';
    return `    ${kind} ${port.width ? `${port.width} ` : ''}${port.name};`;
  });
  const connections = module.ports.map((port, index) => {
    const comma = index === module.ports.length - 1 ? '' : ',';
    return `        .${port.name}(${port.name})${comma}`;
  });
  const hasClk = module.ports.some((port) => port.name === 'clk');
  const hasReset = module.ports.some((port) => port.name === 'reset');
  const lines: string[] = [
    '`timescale 1ns / 1ps',
    '',
    `module ${tbName};`,
    ...declarations,
    '',
    `    ${module.name} uut (`,
    ...connections,
    '    );',
    ''
  ];

  if (hasClk) {
    lines.push(
      '    initial begin',
      "        clk = 1'b0;",
      '        forever #5 clk = ~clk;',
      '    end',
      ''
    );
  }

  lines.push('    initial begin');
  if (hasReset) {
    lines.push(
      "        reset = 1'b1;",
      '        #20;',
      "        reset = 1'b0;"
    );
  }
  lines.push('        #200000;', '        $finish;', '    end', 'endmodule', '');
  return lines.join('\n');
}

export function normalizeWidth(width?: string): string | undefined {
  return width?.replace(/\s+/g, '');
}

export function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => ' '.repeat(match.length))
    .replace(/\/\/.*$/gm, (match) => ' '.repeat(match.length))
    .replace(/"([^"\\]|\\.)*"/g, (match) => ' '.repeat(match.length));
}

function parseHeaderPorts(document: TextDocument, fullText: string, header: string, moduleStart: number): VerilogDecl[] {
  const ports: VerilogDecl[] = [];
  const parts = splitTopLevelCommas(header);
  let inheritedDirection: 'input' | 'output' | 'inout' | undefined;
  let inheritedWidth: string | undefined;
  for (const part of parts) {
    const trimmed = part.trim();
    const directionMatch = trimmed.match(/^(input|output|inout)\b/);
    const widthMatch = trimmed.match(/\[[^\]]+\]/);
    const port = parseDeclFragment(document, fullText, part, moduleStart);
    if (port) {
      if (!port.direction && inheritedDirection) {
        port.direction = inheritedDirection;
        port.kind = inheritedDirection;
      }
      if (!port.width && inheritedWidth) {
        port.width = inheritedWidth;
      }
      ports.push(port);
    }
    if (directionMatch) {
      inheritedDirection = directionMatch[1] as 'input' | 'output' | 'inout';
    }
    if (widthMatch) {
      inheritedWidth = normalizeWidth(widthMatch[0]);
    } else if (directionMatch) {
      inheritedWidth = undefined;
    }
  }
  return ports;
}

function parseDeclarations(document: TextDocument, fullText: string, startOffset: number, endOffset: number): VerilogDecl[] {
  const text = fullText.slice(startOffset, endOffset);
  const declarations: VerilogDecl[] = [];
  const declRegex = /\b(input|output|inout|wire|reg|logic|integer|parameter|localparam|genvar)\b\s*(?:(?:reg|wire|logic)\s+)?(?:signed\s+)?(\[[^\]]+\]\s*)?([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(text))) {
    const kind = match[1] as VerilogDeclKind;
    const width = normalizeWidth(match[2]);
    const names = splitTopLevelCommas(match[3]);
    for (const rawName of names) {
      const nameMatch = rawName.trim().match(/^([A-Za-z_]\w*)/);
      if (!nameMatch) {
        continue;
      }
      const name = nameMatch[1];
      const absoluteNameOffset = startOffset + match.index + match[0].indexOf(rawName) + rawName.indexOf(name);
      declarations.push({
        name,
        kind,
        width,
        direction: kind === 'input' || kind === 'output' || kind === 'inout' ? kind : undefined,
        range: Range.create(document.positionAt(startOffset + match.index), document.positionAt(startOffset + match.index + match[0].length)),
        selectionRange: Range.create(document.positionAt(absoluteNameOffset), document.positionAt(absoluteNameOffset + name.length))
      });
    }
  }
  return declarations;
}

function parseDeclFragment(document: TextDocument, fullText: string, fragment: string, moduleStart: number): VerilogDecl | undefined {
  const trimmed = fragment.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^(?:(input|output|inout)\s+)?(?:(reg|wire|logic)\s+)?(?:signed\s+)?(\[[^\]]+\]\s*)?([A-Za-z_]\w*)$/);
  if (!match) {
    const nameOnly = trimmed.match(/^([A-Za-z_]\w*)$/);
    if (!nameOnly) {
      return undefined;
    }
    const offset = fullText.indexOf(nameOnly[1], moduleStart);
    return {
      name: nameOnly[1],
      kind: 'wire',
      range: Range.create(document.positionAt(offset), document.positionAt(offset + nameOnly[1].length)),
      selectionRange: Range.create(document.positionAt(offset), document.positionAt(offset + nameOnly[1].length))
    };
  }
  const direction = match[1] as 'input' | 'output' | 'inout' | undefined;
  const kind = (direction ?? match[2] ?? 'wire') as VerilogDeclKind;
  const name = match[4];
  const offset = fullText.indexOf(name, moduleStart);
  return {
    name,
    kind,
    direction,
    width: normalizeWidth(match[3]),
    range: Range.create(document.positionAt(offset), document.positionAt(offset + fragment.length)),
    selectionRange: Range.create(document.positionAt(offset), document.positionAt(offset + name.length))
  };
}

function parseInstances(document: TextDocument, fullText: string, startOffset: number, endOffset: number, currentModuleName: string): VerilogInstance[] {
  const text = stripCommentsAndStrings(fullText.slice(startOffset, endOffset));
  const instances: VerilogInstance[] = [];
  const instanceRegex = /\b([A-Za-z_]\w*)\s*(?:#\s*\([^;]*?\)\s*)?([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = instanceRegex.exec(text))) {
    const moduleName = match[1];
    const instanceName = match[2];
    if (moduleName === currentModuleName || verilogKeywords.has(moduleName) || systemTasks.has(moduleName)) {
      continue;
    }
    const instanceOffset = startOffset + match.index + match[0].indexOf(instanceName);
    instances.push({
      moduleName,
      instanceName,
      range: Range.create(document.positionAt(startOffset + match.index), document.positionAt(startOffset + match.index + match[0].length)),
      selectionRange: Range.create(document.positionAt(instanceOffset), document.positionAt(instanceOffset + instanceName.length))
    });
  }
  return instances;
}

function collectVerilogDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (settings.verilog.lint.courseRules) {
    collectCourseDiagnostics(document, settings, text, modules, diagnostics);
    collectAssignmentDiagnostics(document, text, modules, diagnostics);
  }
  collectImplicitNetDiagnostics(document, settings, text, modules, diagnostics);
  return diagnostics;
}

function collectCourseDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const profile = settings.project.profile;
  const topName = settings.project.topModule.trim() || 'mips';
  const top = modules.find((module) => module.name === topName);

  if ((profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7') && !top) {
    const firstLine = lineAt(document, 0).text;
    diagnostics.push(makeDiagnostic(Range.create(0, 0, 0, Math.max(1, firstLine.length)), `Top module '${topName}' was not found.`, DiagnosticSeverity.Warning, 'missing-top'));
  }

  if (top && (profile === 'P4' || profile === 'P5' || profile === 'P6' || profile === 'P7')) {
    checkExpectedPorts(top, profile, diagnostics);
  }

  if (profile === 'P6') {
    const displayRegex = /\$display\b/g;
    let match: RegExpExecArray | null;
    while ((match = displayRegex.exec(text))) {
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, match.index, '$display'.length), 'P6 top-level design should not contain $display; the testbench should monitor external outputs.', DiagnosticSeverity.Error, 'p6-display'));
    }
  }

  if (profile === 'P4' || profile === 'P5') {
    validateDisplayFormats(document, text, profile, diagnostics);
  }

  if (!/`default_nettype\s+none/.test(text)) {
    const firstLine = lineAt(document, 0).text;
    diagnostics.push(makeDiagnostic(Range.create(0, 0, 0, Math.max(1, firstLine.length)), 'Consider adding `default_nettype none to catch implicit wires early.', DiagnosticSeverity.Information, 'default-nettype-none'));
  }
}

function collectAssignmentDiagnostics(document: TextDocument, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const bodyStart = document.offsetAt(module.headerEnd);
    const body = text.slice(bodyStart, document.offsetAt(module.range.end));
    const assignmentKinds = new Map<string, Set<string>>();
    const assignRegex = /\b([A-Za-z_]\w*)\s*(<=|=)(?!=)/g;
    let match: RegExpExecArray | null;
    while ((match = assignRegex.exec(stripCommentsAndStrings(body)))) {
      const lhs = match[1];
      const operator = match[2];
      if (!assignmentKinds.has(lhs)) {
        assignmentKinds.set(lhs, new Set());
      }
      assignmentKinds.get(lhs)?.add(operator);
    }
    for (const [name, operators] of assignmentKinds) {
      if (operators.has('=') && operators.has('<=')) {
        const decl = module.declarations.get(name);
        const range = decl?.selectionRange ?? module.selectionRange;
        diagnostics.push(makeDiagnostic(range, `Signal '${name}' is assigned with both blocking and nonblocking assignments.`, DiagnosticSeverity.Warning, 'mixed-assignment'));
      }
    }
  }
}

function collectImplicitNetDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const severityMode = settings.verilog.implicitNet.diagnostic;
  if (severityMode === 'off') {
    return;
  }
  const severity = severityMode === 'error'
    ? DiagnosticSeverity.Error
    : severityMode === 'hint'
      ? DiagnosticSeverity.Hint
      : DiagnosticSeverity.Warning;
  const ignorePatterns = settings.verilog.implicitNet.ignorePatterns.map((pattern) => safeRegExp(pattern)).filter((item): item is RegExp => Boolean(item));

  for (const module of modules) {
    const declared = new Set<string>([module.name]);
    for (const decl of module.declarations.values()) {
      declared.add(decl.name);
    }
    for (const instance of module.instances) {
      declared.add(instance.instanceName);
      declared.add(instance.moduleName);
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const stripped = stripCommentsAndStrings(text.slice(bodyStart, bodyEnd));
    const tokenRegex = /\b[A-Za-z_]\w*\b/g;
    const reported = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(stripped))) {
      const token = match[0];
      const absolute = bodyStart + match.index;
      const previous = text[absolute - 1] ?? '';
      if (
        declared.has(token) ||
        reported.has(token) ||
        verilogKeywords.has(token) ||
        systemTasks.has(token) ||
        previous === '.' ||
        previous === '`' ||
        previous === '$' ||
        previous === "'"
      ) {
        continue;
      }
      if (ignorePatterns.some((pattern) => pattern.test(token))) {
        continue;
      }
      reported.add(token);
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, absolute, token.length), `Implicit net or undeclared identifier '${token}'.`, severity, `implicit-net:${token}`));
    }
  }
}

function checkExpectedPorts(module: VerilogModule, profile: ProjectProfile, diagnostics: Diagnostic[]): void {
  const expected = expectedPorts[profile];
  if (!expected) {
    return;
  }
  const portsByName = new Map(module.ports.map((port) => [port.name, port]));
  for (const [name, width] of Object.entries(expected)) {
    const port = portsByName.get(name);
    if (!port) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `${profile} top module is missing port '${name}'.`, DiagnosticSeverity.Error, `${profile.toLowerCase()}-port`));
      continue;
    }
    if (width && port.width && normalizeWidth(port.width) !== width) {
      diagnostics.push(makeDiagnostic(port.selectionRange, `${profile} port '${name}' is expected to be ${width}, got ${port.width}.`, DiagnosticSeverity.Warning, `${profile.toLowerCase()}-port-width`));
    }
  }
}

function validateDisplayFormats(document: TextDocument, text: string, profile: ProjectProfile, diagnostics: Diagnostic[]): void {
  const displayRegex = /\$display\s*\(\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = displayRegex.exec(text))) {
    const format = match[1];
    const ok = profile === 'P5'
      ? /%d@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/.test(format)
      : /@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/.test(format);
    if (!ok) {
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, match.index, '$display'.length), `${profile} $display format does not match the expected CPU trace format.`, DiagnosticSeverity.Warning, 'display-format'));
    }
  }
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function findEndmodule(text: string, from: number): number {
  const index = text.indexOf('endmodule', from);
  if (index < 0) {
    return text.length;
  }
  return index + 'endmodule'.length;
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

