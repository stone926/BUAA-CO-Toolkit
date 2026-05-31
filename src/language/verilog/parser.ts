import * as fs from 'fs';
import * as path from 'path';
import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { ProjectProfile } from '../../projectProfile';
import { containsPosition, lineAt, makeDiagnostic, rangeAtOffset } from '../common/lsp';
import { CoSettings } from '../common/settings';
import { escapeRegExp, rangeKey } from '../common/util';
import {
  expectedPorts,
  systemTasks,
  VerilogDecl,
  VerilogDeclKind,
  VerilogInclude,
  VerilogInstance,
  VerilogMacro,
  VerilogMacroUse,
  VerilogModule,
  VerilogParseResult,
  VerilogPortConnection,
  verilogKeywords
} from './model';

interface TextSpan {
  text: string;
  start: number;
  end: number;
}

interface EndmoduleInfo {
  found: boolean;
  startOffset: number;
  endOffset: number;
}

interface IdentifierToken {
  value: string;
  start: number;
  end: number;
}

interface AlwaysBlockInfo {
  sensitivity: string;
  range: Range;
  headerRange: Range;
  bodyText: string;
  bodyOffset: number;
  sequential: boolean;
  combinational: boolean;
}

interface AssignmentUse {
  name: string;
  operator: '=' | '<=';
  range: Range;
  blockIndex: number;
}

const preprocessorDirectives = new Set([
  'define',
  'undef',
  'ifdef',
  'ifndef',
  'elsif',
  'else',
  'endif',
  'include',
  'timescale',
  'default_nettype'
]);

export function parseVerilog(document: TextDocument, settings: CoSettings, includeDiagnostics: boolean): VerilogParseResult {
  const text = document.getText();
  const modules = parseModules(document, text);
  const macros = parseMacros(document, text);
  const macroUses = parseMacroUses(document, text, macros);
  const includes = parseIncludes(document, text);
  const diagnostics = includeDiagnostics ? collectVerilogDiagnostics(document, settings, text, modules, includes) : [];
  return {
    modules,
    macros,
    macroUses,
    includes,
    diagnostics
  };
}

export function parseModules(document: TextDocument, text: string): VerilogModule[] {
  const modules: VerilogModule[] = [];
  const searchable = stripCommentsAndStrings(text);
  const moduleRegex = /\bmodule\s+([A-Za-z_]\w*)\s*(?:#\s*\(([\s\S]*?)\)\s*)?(?:\(([\s\S]*?)\)\s*)?;/g;
  let match: RegExpExecArray | null;
  while ((match = moduleRegex.exec(searchable))) {
    const name = match[1];
    const parameterText = match[2] ?? '';
    const header = match[3] ?? '';
    const bodyStartOffset = match.index + match[0].length;
    const endmodule = findEndmodule(searchable, bodyStartOffset);
    const nameOffset = match.index + match[0].indexOf(name);
    const parameterOffset = parameterText ? match.index + match[0].indexOf(parameterText) : -1;
    const headerOffset = header ? match.index + match[0].lastIndexOf(header) : bodyStartOffset;
    const module: VerilogModule = {
      name,
      ports: [],
      parameters: [],
      declarations: new Map(),
      instances: [],
      range: Range.create(document.positionAt(match.index), document.positionAt(endmodule.endOffset)),
      selectionRange: Range.create(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length)),
      headerEnd: document.positionAt(bodyStartOffset),
      uri: document.uri,
      bodyText: text.slice(bodyStartOffset, endmodule.endOffset),
      hasEndmodule: endmodule.found,
      endmoduleRange: endmodule.found
        ? Range.create(document.positionAt(endmodule.startOffset), document.positionAt(endmodule.endOffset))
        : undefined
    };

    for (const param of parseParameterDeclarations(document, parameterText, parameterOffset)) {
      module.parameters.push(param);
      module.declarations.set(param.name, param);
    }

    for (const port of parseHeaderPorts(document, text, header, headerOffset)) {
      module.ports.push(port);
      module.declarations.set(port.name, port);
    }

    for (const decl of parseDeclarations(document, text, bodyStartOffset, endmodule.startOffset)) {
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
        } else {
          module.ports.push(merged);
        }
      } else {
        module.declarations.set(decl.name, decl);
        if (decl.kind === 'input' || decl.kind === 'output' || decl.kind === 'inout') {
          module.ports.push({
            ...decl,
            direction: decl.kind
          });
        }
        if (decl.kind === 'parameter' || decl.kind === 'localparam') {
          module.parameters.push(decl);
        }
      }
    }

    module.instances = parseInstances(document, text, bodyStartOffset, endmodule.startOffset, module.name);
    modules.push(module);
  }
  return modules;
}

export function parseMacros(document: TextDocument, text: string): VerilogMacro[] {
  const macros: VerilogMacro[] = [];
  const stripped = stripCommentsAndStrings(text);
  const macroRegex = /^\s*`define\s+([A-Za-z_]\w*)/gm;
  let match: RegExpExecArray | null;
  while ((match = macroRegex.exec(stripped))) {
    const offset = match.index + match[0].indexOf(match[1]);
    macros.push({
      name: match[1],
      range: lineAt(document, document.positionAt(offset).line).range,
      selectionRange: Range.create(document.positionAt(offset), document.positionAt(offset + match[1].length))
    });
  }
  return macros;
}

export function parseMacroUses(document: TextDocument, text: string, macros: VerilogMacro[] = parseMacros(document, text)): VerilogMacroUse[] {
  const uses: VerilogMacroUse[] = [];
  const declarationRanges = new Set(macros.map((macro) => rangeKey(macro.selectionRange)));
  const stripped = stripCommentsAndStrings(text);
  const macroRegex = /`([A-Za-z_]\w*)/g;
  let match: RegExpExecArray | null;
  while ((match = macroRegex.exec(stripped))) {
    const name = match[1];
    const nameOffset = match.index + 1;
    const selectionRange = Range.create(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length));
    if (preprocessorDirectives.has(name) || declarationRanges.has(rangeKey(selectionRange))) {
      continue;
    }
    uses.push({
      name,
      range: Range.create(document.positionAt(match.index), document.positionAt(nameOffset + name.length)),
      selectionRange
    });
  }
  return uses;
}

export function parseIncludes(document: TextDocument, text: string): VerilogInclude[] {
  const includes: VerilogInclude[] = [];
  const stripped = stripCommentsAndStrings(text);
  const includeRegex = /^\s*`include\s+"([^"]+)"/gm;
  let match: RegExpExecArray | null;
  while ((match = includeRegex.exec(stripped))) {
    const pathOffset = match.index + match[0].indexOf(match[1]);
    includes.push({
      path: match[1],
      range: lineAt(document, document.positionAt(match.index).line).range,
      pathRange: Range.create(document.positionAt(pathOffset), document.positionAt(pathOffset + match[1].length))
    });
  }
  return includes;
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

export function splitTopLevelCommas(text: string): string[] {
  return splitTopLevelCommaSpans(text).map((span) => span.text);
}

export function splitTopLevelCommaSpans(text: string): TextSpan[] {
  const parts: TextSpan[] = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      escaped = char === '\\' && !escaped;
      if (char === '"' && !escaped) {
        inString = false;
      } else if (char !== '\\') {
        escaped = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      parts.push({ text: text.slice(start, index), start, end: index });
      start = index + 1;
    }
  }
  parts.push({ text: text.slice(start), start, end: text.length });
  return parts;
}

function parseHeaderPorts(document: TextDocument, fullText: string, header: string, headerOffset: number): VerilogDecl[] {
  const ports: VerilogDecl[] = [];
  const parts = splitTopLevelCommaSpans(header);
  let inheritedDirection: 'input' | 'output' | 'inout' | undefined;
  let inheritedWidth: string | undefined;
  for (const part of parts) {
    const trimmed = part.text.trim();
    const directionMatch = trimmed.match(/^(input|output|inout)\b/);
    const widthMatch = trimmed.match(/\[[^\]]+\]/);
    const port = parseDeclFragment(document, fullText, part.text, headerOffset + part.start);
    if (port) {
      if (directionMatch) {
        port.direction = directionMatch[1] as 'input' | 'output' | 'inout';
        port.kind = port.direction;
        port.width = widthMatch ? normalizeWidth(widthMatch[0]) : port.width;
      } else if (inheritedDirection) {
        port.direction = inheritedDirection;
        port.kind = inheritedDirection;
        if (!port.width && inheritedWidth) {
          port.width = inheritedWidth;
        }
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

function parseParameterDeclarations(document: TextDocument, parameterText: string, parameterOffset: number): VerilogDecl[] {
  const parameters: VerilogDecl[] = [];
  if (!parameterText || parameterOffset < 0) {
    return parameters;
  }
  for (const part of splitTopLevelCommaSpans(parameterText)) {
    const leading = leadingWhitespaceLength(part.text);
    const trimmed = part.text.trim();
    const match = trimmed.match(/^(?:(parameter|localparam)\b\s*)?(?:(?:integer|reg|wire|logic)\b\s*)?(?:signed\b\s*)?(\[[^\]]+\]\s*)?([A-Za-z_]\w*)/);
    if (!match) {
      continue;
    }
    const kind = (match[1] ?? 'parameter') as VerilogDeclKind;
    const width = normalizeWidth(match[2]);
    const name = match[3];
    const nameOffset = parameterOffset + part.start + leading + match[0].lastIndexOf(name);
    parameters.push({
      name,
      kind,
      width,
      range: Range.create(document.positionAt(parameterOffset + part.start), document.positionAt(parameterOffset + part.end)),
      selectionRange: Range.create(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length))
    });
  }
  return parameters;
}

function parseDeclarations(document: TextDocument, fullText: string, startOffset: number, endOffset: number): VerilogDecl[] {
  const text = stripCommentsAndStrings(fullText.slice(startOffset, endOffset));
  const declarations: VerilogDecl[] = [];
  const declRegex = /\b(input|output|inout|wire|reg|logic|integer|real|realtime|time|parameter|localparam|genvar)\b\s*(?:(?:integer|reg|wire|logic|real|realtime|time)\b\s*)?(?:signed\b\s*)?(\[[^\]]+\]\s*)?([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = declRegex.exec(text))) {
    const kind = match[1] as VerilogDeclKind;
    const width = normalizeWidth(match[2]);
    const namesOffset = match[0].lastIndexOf(match[3]);
    const names = splitTopLevelCommaSpans(match[3]);
    for (const rawName of names) {
      const leading = leadingWhitespaceLength(rawName.text);
      const trimmed = rawName.text.trim();
      const nameMatch = trimmed.match(/^([A-Za-z_]\w*)/);
      if (!nameMatch) {
        continue;
      }
      const name = nameMatch[1];
      const absoluteNameOffset = startOffset + match.index + namesOffset + rawName.start + leading;
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

function parseDeclFragment(document: TextDocument, fullText: string, fragment: string, fragmentOffset: number): VerilogDecl | undefined {
  const leading = leadingWhitespaceLength(fragment);
  const trimmed = fragment.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/^(?:(input|output|inout)\b\s*)?(?:(reg|wire|logic|integer|real|realtime|time)\b\s*)?(?:signed\b\s*)?(\[[^\]]+\]\s*)?([A-Za-z_]\w*)(?:\s*=.*)?$/);
  if (!match) {
    const nameOnly = trimmed.match(/^([A-Za-z_]\w*)$/);
    if (!nameOnly) {
      return undefined;
    }
    const name = nameOnly[1];
    const offset = fragmentOffset + leading + trimmed.indexOf(name);
    return {
      name,
      kind: 'wire',
      range: Range.create(document.positionAt(offset), document.positionAt(offset + name.length)),
      selectionRange: Range.create(document.positionAt(offset), document.positionAt(offset + name.length))
    };
  }
  const direction = match[1] as 'input' | 'output' | 'inout' | undefined;
  const kind = (direction ?? match[2] ?? 'wire') as VerilogDeclKind;
  const name = match[4];
  const declarationPrefix = trimmed.replace(/\s*=.*$/, '');
  const nameOffset = fragmentOffset + leading + declarationPrefix.lastIndexOf(name);
  return {
    name,
    kind,
    direction,
    width: normalizeWidth(match[3]),
    range: Range.create(document.positionAt(fragmentOffset), document.positionAt(fragmentOffset + fragment.length)),
    selectionRange: Range.create(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length))
  };
}

function parseInstances(document: TextDocument, fullText: string, startOffset: number, endOffset: number, currentModuleName: string): VerilogInstance[] {
  const stripped = stripCommentsAndStrings(fullText.slice(startOffset, endOffset));
  const instances: VerilogInstance[] = [];
  let statementStart = 0;
  for (let index = 0; index < stripped.length; index++) {
    if (stripped[index] !== ';') {
      continue;
    }
    const statement = fullText.slice(startOffset + statementStart, startOffset + index + 1);
    const searchableStatement = stripped.slice(statementStart, index + 1);
    const instance = parseInstanceStatement(document, statement, searchableStatement, startOffset + statementStart, currentModuleName);
    if (instance) {
      instances.push(instance);
    }
    statementStart = index + 1;
  }
  return instances;
}

function parseInstanceStatement(
  document: TextDocument,
  statement: string,
  searchableStatement: string,
  statementOffset: number,
  currentModuleName: string
): VerilogInstance | undefined {
  let position = skipWhitespace(searchableStatement, 0);
  const moduleToken = readIdentifier(searchableStatement, position);
  if (!moduleToken) {
    return undefined;
  }
  if (
    moduleToken.value === currentModuleName ||
    verilogKeywords.has(moduleToken.value) ||
    systemTasks.has(moduleToken.value) ||
    moduleToken.value.startsWith('$')
  ) {
    return undefined;
  }

  position = skipWhitespace(searchableStatement, moduleToken.end);
  let parameterConnections: VerilogPortConnection[] = [];
  let parameterListRange: Range | undefined;
  if (searchableStatement[position] === '#') {
    position = skipWhitespace(searchableStatement, position + 1);
    if (searchableStatement[position] !== '(') {
      return undefined;
    }
    const close = findMatchingParen(searchableStatement, position);
    if (close === undefined) {
      return undefined;
    }
    const contentStart = position + 1;
    const content = statement.slice(contentStart, close);
    parameterConnections = parseConnectionList(document, content, statementOffset + contentStart);
    parameterListRange = Range.create(document.positionAt(statementOffset + contentStart), document.positionAt(statementOffset + close));
    position = skipWhitespace(searchableStatement, close + 1);
  }

  const instanceToken = readIdentifier(searchableStatement, position);
  if (!instanceToken) {
    return undefined;
  }
  position = skipWhitespace(searchableStatement, instanceToken.end);
  if (searchableStatement.slice(position).trim() === ';') {
    const moduleStart = statementOffset + moduleToken.start;
    const instanceStart = statementOffset + instanceToken.start;
    return {
      moduleName: moduleToken.value,
      instanceName: instanceToken.value,
      range: Range.create(document.positionAt(statementOffset + moduleToken.start), document.positionAt(statementOffset + searchableStatement.length)),
      moduleSelectionRange: Range.create(document.positionAt(moduleStart), document.positionAt(moduleStart + moduleToken.value.length)),
      selectionRange: Range.create(document.positionAt(instanceStart), document.positionAt(instanceStart + instanceToken.value.length)),
      portConnections: [],
      parameterConnections
    };
  }
  if (searchableStatement[position] !== '(') {
    return undefined;
  }
  const close = findMatchingParen(searchableStatement, position);
  if (close === undefined) {
    return undefined;
  }
  const rest = searchableStatement.slice(close + 1).trim();
  if (rest !== ';') {
    return undefined;
  }

  const portContentStart = position + 1;
  const portContent = statement.slice(portContentStart, close);
  const moduleStart = statementOffset + moduleToken.start;
  const instanceStart = statementOffset + instanceToken.start;
  return {
    moduleName: moduleToken.value,
    instanceName: instanceToken.value,
    range: Range.create(document.positionAt(statementOffset + moduleToken.start), document.positionAt(statementOffset + searchableStatement.length)),
    moduleSelectionRange: Range.create(document.positionAt(moduleStart), document.positionAt(moduleStart + moduleToken.value.length)),
    selectionRange: Range.create(document.positionAt(instanceStart), document.positionAt(instanceStart + instanceToken.value.length)),
    portListRange: Range.create(document.positionAt(statementOffset + portContentStart), document.positionAt(statementOffset + close)),
    parameterListRange,
    portConnections: parseConnectionList(document, portContent, statementOffset + portContentStart),
    parameterConnections
  };
}

function parseConnectionList(document: TextDocument, text: string, offset: number): VerilogPortConnection[] {
  const connections: VerilogPortConnection[] = [];
  let positionalIndex = 0;
  const searchable = stripCommentsAndStrings(text);
  for (const part of splitTopLevelCommaSpans(searchable)) {
    const rawText = text.slice(part.start, part.end);
    const trimmed = part.text.trim();
    if (!trimmed) {
      continue;
    }
    const leading = leadingWhitespaceLength(part.text);
    const absoluteStart = offset + part.start;
    const named = trimmed.match(/^\.\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)$/);
    if (named) {
      const name = named[1];
      const nameOffset = absoluteStart + leading + trimmed.indexOf(name);
      const openParen = part.text.indexOf('(', part.text.indexOf(name) + name.length);
      const closeParen = part.text.lastIndexOf(')');
      const expressionStart = absoluteStart + openParen + 1;
      const expressionEnd = absoluteStart + Math.max(openParen + 1, closeParen);
      connections.push({
        name,
        nameRange: Range.create(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length)),
        expression: rawText.slice(openParen + 1, closeParen),
        expressionRange: Range.create(document.positionAt(expressionStart), document.positionAt(expressionEnd)),
        range: Range.create(document.positionAt(absoluteStart), document.positionAt(offset + part.end)),
        positionalIndex
      });
    } else {
      const shorthand = trimmed.match(/^\.\s*([A-Za-z_]\w*)$/);
      if (shorthand) {
        const name = shorthand[1];
        const nameOffset = absoluteStart + leading + trimmed.indexOf(name);
        const end = offset + part.end;
        connections.push({
          name,
          nameRange: Range.create(document.positionAt(nameOffset), document.positionAt(nameOffset + name.length)),
          expression: '',
          expressionRange: Range.create(document.positionAt(end), document.positionAt(end)),
          range: Range.create(document.positionAt(absoluteStart), document.positionAt(end)),
          positionalIndex,
          shorthand: true
        });
      } else {
        const expressionStart = absoluteStart + leading;
        const expressionEnd = expressionStart + trimmed.length;
        connections.push({
          expression: rawText.trim(),
          expressionRange: Range.create(document.positionAt(expressionStart), document.positionAt(expressionEnd)),
          range: Range.create(document.positionAt(absoluteStart), document.positionAt(offset + part.end)),
          positionalIndex
        });
      }
    }
    positionalIndex++;
  }
  return connections;
}

function collectVerilogDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], includes: VerilogInclude[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  collectStructuralDiagnostics(document, modules, diagnostics);
  collectIncludeDiagnostics(document, includes, diagnostics);
  collectInstancePortDiagnostics(modules, diagnostics);
  collectWidthDiagnostics(document, text, modules, diagnostics);
  if (settings.verilog.lint.courseRules) {
    collectCourseDiagnostics(document, settings, text, modules, diagnostics);
    collectAssignmentDiagnostics(document, text, modules, diagnostics);
    collectCourseStyleDiagnostics(document, settings, text, modules, diagnostics);
  }
  if (settings.verilog.lint.synthesizableHints) {
    collectSynthesizableHintDiagnostics(document, text, modules, diagnostics);
  }
  collectImplicitNetDiagnostics(document, settings, text, modules, diagnostics);
  return diagnostics;
}

function collectStructuralDiagnostics(document: TextDocument, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const seenModules = new Map<string, VerilogModule>();
  for (const module of modules) {
    if (!module.hasEndmodule) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `Module '${module.name}' is missing endmodule.`, DiagnosticSeverity.Error, 'missing-endmodule'));
    }
    const previous = seenModules.get(module.name);
    if (previous) {
      diagnostics.push(makeDiagnostic(module.selectionRange, `Duplicate module '${module.name}'. First definition is at line ${previous.selectionRange.start.line + 1}.`, DiagnosticSeverity.Error, 'duplicate-module'));
    } else {
      seenModules.set(module.name, module);
    }
  }
}

function collectIncludeDiagnostics(document: TextDocument, includes: VerilogInclude[], diagnostics: Diagnostic[]): void {
  if (!includes.length || document.uri.startsWith('untitled:')) {
    return;
  }
  let baseDir: string | undefined;
  try {
    baseDir = path.dirname(URI.parse(document.uri).fsPath);
  } catch {
    return;
  }
  for (const include of includes) {
    const includePath = path.isAbsolute(include.path) ? include.path : path.resolve(baseDir, include.path);
    if (!fs.existsSync(includePath)) {
      diagnostics.push(makeDiagnostic(include.pathRange, `Included file '${include.path}' was not found relative to this file.`, DiagnosticSeverity.Warning, 'missing-include'));
    }
  }
}

function collectInstancePortDiagnostics(modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  for (const module of modules) {
    for (const instance of module.instances) {
      const target = modulesByName.get(instance.moduleName);
      if (!target) {
        continue;
      }
      const targetPorts = new Map(target.ports.map((port) => [port.name, port]));
      const seenConnections = new Map<string, VerilogPortConnection>();
      for (const connection of instance.portConnections) {
        if (!connection.name) {
          continue;
        }
        const previous = seenConnections.get(connection.name);
        if (previous) {
          diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Port '${connection.name}' is connected more than once.`, DiagnosticSeverity.Warning, 'duplicate-port-connection'));
          continue;
        }
        seenConnections.set(connection.name, connection);
        if (!targetPorts.has(connection.name)) {
          diagnostics.push(makeDiagnostic(connection.nameRange ?? connection.range, `Module '${target.name}' has no port named '${connection.name}'.`, DiagnosticSeverity.Error, 'unknown-port'));
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
}

export interface WidthInfo {
  width?: number;
  minWidth?: number;
  flexible?: boolean;
}

function collectWidthDiagnostics(document: TextDocument, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const modulesByName = new Map(modules.map((module) => [module.name, module]));
  for (const module of modules) {
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const body = text.slice(bodyStart, bodyEnd);
    const stripped = stripCommentsAndStrings(body);
    const assignmentRegex = /(?:\bassign\s+)?([A-Za-z_]\w*(?:\s*\[[^\]]+\])?)\s*(?:<=|=)(?!=)\s*([^;]+);/g;
    let match: RegExpExecArray | null;
    while ((match = assignmentRegex.exec(stripped))) {
      if (isInsideForControl(stripped, match.index)) {
        continue;
      }
      const lhsText = match[1].trim();
      const rhsText = match[2].trim();
      const lhs = widthOfExpression(lhsText, module);
      const rhs = widthOfExpression(rhsText, module);
      if (shouldReportWidthMismatch(lhs, rhs)) {
        const absolute = bodyStart + match.index + match[0].indexOf(rhsText);
        diagnostics.push(makeDiagnostic(
          rangeAtOffset(document, absolute, rhsText.length),
          `Width mismatch: '${lhsText}' is ${lhs.width} bit(s), but this expression is ${rhs.width} bit(s).`,
          DiagnosticSeverity.Warning,
          'width-mismatch'
        ));
      }
    }

    for (const instance of module.instances) {
      const target = modulesByName.get(instance.moduleName);
      if (!target) {
        continue;
      }
      for (const connection of instance.portConnections) {
        const targetPort = connection.name
          ? target.ports.find((port) => port.name === connection.name)
          : target.ports[connection.positionalIndex];
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
    }
  }
}

export function shouldReportWidthMismatch(expected: WidthInfo, actual: WidthInfo): boolean {
  if (!expected.width || !actual.width || expected.width === actual.width) {
    return false;
  }
  if (actual.flexible && (actual.minWidth ?? actual.width) <= expected.width) {
    return false;
  }
  return true;
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
    const strippedText = stripCommentsAndStrings(text);
    const displayRegex = /\$display\b/g;
    let match: RegExpExecArray | null;
    while ((match = displayRegex.exec(strippedText))) {
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

function collectCourseStyleDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    collectNamingDiagnostics(module, diagnostics);
    collectAlwaysStyleDiagnostics(document, text, module, diagnostics);
    collectInstantiationStyleDiagnostics(document, module, diagnostics);
    collectDeclarationGroupingDiagnostics(document, text, module, diagnostics);
    collectExplicitWidthDiagnostics(module, diagnostics);
    collectMagicNumberDiagnostics(document, text, module, diagnostics);
    collectWhitespaceDiagnostics(document, text, module, diagnostics);
    collectAbstractionDiagnostics(module, diagnostics);
    collectInoutDiagnostics(settings, module, diagnostics);
  }
  collectTestbenchDiagnostics(document, settings, text, modules, diagnostics);
}

function collectSynthesizableHintDiagnostics(document: TextDocument, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  const stripped = stripCommentsAndStrings(text);
  const initialRegex = /\binitial\b/g;
  let initialMatch: RegExpExecArray | null;
  while ((initialMatch = initialRegex.exec(stripped))) {
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, initialMatch.index, 'initial'.length), 'Synthesizable style: avoid initial blocks in design modules; use reset logic instead.', DiagnosticSeverity.Information, 'synth-initial'));
  }

  const declInitializerRegex = /\b(reg|logic|integer)\b\s*(?:signed\s*)?(?:\[[^\]]+\]\s*)?[A-Za-z_]\w*\s*=/g;
  let initializerMatch: RegExpExecArray | null;
  while ((initializerMatch = declInitializerRegex.exec(stripped))) {
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, initializerMatch.index, initializerMatch[0].length), 'Synthesizable style: avoid declaration initializers for registers; reset them in clocked logic.', DiagnosticSeverity.Information, 'synth-decl-init'));
  }

  const mulDivRegex = /(?<![*/])(?:\*|\/|%)(?![*/])/g;
  let operatorMatch: RegExpExecArray | null;
  while ((operatorMatch = mulDivRegex.exec(stripped))) {
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, operatorMatch.index, operatorMatch[0].length), 'Synthesizable style: avoid multiply/divide/modulo operators on FPGA datapaths unless the hardware cost is intentional.', DiagnosticSeverity.Information, 'synth-mul-div'));
  }
}

function collectNamingDiagnostics(module: VerilogModule, diagnostics: Diagnostic[]): void {
  const styleCounts = new Map<string, number>();
  for (const decl of module.declarations.values()) {
    const style = identifierStyle(decl.name);
    if (!style) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-001: signal '${decl.name}' should use snake_case, camelCase, or PascalCase.`, DiagnosticSeverity.Information, 'vc-001-name-style'));
    } else {
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
    }
    if (looksLowActiveWithoutSuffix(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-002: low-active signal '${decl.name}' should use the _n suffix.`, DiagnosticSeverity.Information, 'vc-002-low-active-suffix'));
    }
    if (/mux/i.test(decl.name) && !/\d/.test(decl.name)) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-003: multiplexer signal '${decl.name}' should reflect its width or input count.`, DiagnosticSeverity.Information, 'vc-003-mux-name'));
    }
  }
  if (styleCounts.size > 1) {
    diagnostics.push(makeDiagnostic(module.selectionRange, 'VC-001: this module mixes signal naming styles; keep one of snake_case, camelCase, or PascalCase consistently.', DiagnosticSeverity.Information, 'vc-001-mixed-name-style'));
  }
}

function collectAlwaysStyleDiagnostics(document: TextDocument, text: string, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const blocks = collectAlwaysBlocks(document, text, module);
  const assignedBlocks = new Map<string, Set<number>>();
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.combinational) {
      if (!/\*/.test(block.sensitivity)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-006: combinational logic should use always @(*) or assign.', DiagnosticSeverity.Warning, 'vc-006-comb-sensitivity'));
      }
      if (/<=(?!=)/.test(block.bodyText)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-007: combinational always blocks should use blocking assignments (=), not nonblocking assignments (<=).', DiagnosticSeverity.Warning, 'vc-007-comb-nonblocking'));
      }
      if (/\bif\b/.test(block.bodyText) && !/\belse\b/.test(block.bodyText)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-008: combinational if statements should cover every branch to avoid inferred latches.', DiagnosticSeverity.Information, 'vc-008-comb-branch'));
      }
      if (/\bcase[xyz]?\b/.test(block.bodyText) && !/\bdefault\b/.test(block.bodyText)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-008: combinational case statements should include default assignments to avoid inferred latches.', DiagnosticSeverity.Information, 'vc-008-case-default'));
      }
    }

    if (block.sequential) {
      if (!/\bposedge\s+[A-Za-z_]\w*/.test(block.sensitivity)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-009: sequential logic should be implemented in always @(posedge clock) blocks.', DiagnosticSeverity.Warning, 'vc-009-seq-posedge'));
      }
      if (/\bnegedge\b/.test(block.sensitivity)) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-011: avoid negedge-triggered logic unless a protocol explicitly requires it.', DiagnosticSeverity.Warning, 'vc-011-negedge'));
      }
      const edgeSignals = [...block.sensitivity.matchAll(/\b(?:posedge|negedge)\s+([A-Za-z_]\w*)/g)].map((match) => match[1]);
      for (const signal of edgeSignals) {
        if (!/(?:clk|clock|reset|rst)/i.test(signal)) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-012: edge trigger on '${signal}' is not a clock/reset signal.`, DiagnosticSeverity.Warning, 'vc-012-edge-signal'));
        }
      }
      if (edgeSignals.length > 1) {
        diagnostics.push(makeDiagnostic(block.headerRange, 'VC-014: prefer synchronous reset; async reset appears in the sensitivity list.', DiagnosticSeverity.Information, 'vc-014-sync-reset'));
      }
      const assignments = collectAssignmentsInText(document, block.bodyText, block.bodyOffset, index);
      for (const assignment of assignments) {
        if (assignment.operator === '=' && !isInsideForControl(block.bodyText, document.offsetAt(assignment.range.start) - block.bodyOffset)) {
          diagnostics.push(makeDiagnostic(assignment.range, 'VC-010: sequential always blocks should use nonblocking assignments (<=).', DiagnosticSeverity.Warning, 'vc-010-seq-blocking'));
        }
      }
      const clockSignals = edgeSignals.filter((signal) => /clk|clock/i.test(signal));
      for (const clock of clockSignals) {
        const clockAsData = new RegExp(`(?:<=|=)\\s*[^;]*\\b${escapeRegExp(clock)}\\b`).exec(block.bodyText);
        if (clockAsData) {
          diagnostics.push(makeDiagnostic(block.headerRange, `VC-013: clock signal '${clock}' should not be used as data inside sequential logic.`, DiagnosticSeverity.Information, 'vc-013-clock-data'));
        }
      }
    }

    for (const assignment of collectAssignmentsInText(document, block.bodyText, block.bodyOffset, index)) {
      const set = assignedBlocks.get(assignment.name) ?? new Set<number>();
      set.add(index);
      assignedBlocks.set(assignment.name, set);
    }
  }
  for (const [name, blockIndexes] of assignedBlocks) {
    if (blockIndexes.size > 1) {
      const decl = module.declarations.get(name);
      diagnostics.push(makeDiagnostic(decl?.selectionRange ?? module.selectionRange, `VC-005: signal '${name}' is assigned in multiple always blocks.`, DiagnosticSeverity.Warning, 'vc-005-multiple-always'));
    }
  }
}

function collectInstantiationStyleDiagnostics(document: TextDocument, module: VerilogModule, diagnostics: Diagnostic[]): void {
  for (const instance of module.instances) {
    if (instance.portConnections.some((connection) => !connection.name)) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `Testbench/VC-017: instance '${instance.instanceName}' should use named port mapping.`, DiagnosticSeverity.Information, 'vc-017-named-ports'));
    }
    if (instance.portConnections.length > 1 && instance.range.start.line === instance.range.end.line) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should use multi-line formatting with one port connection per line.`, DiagnosticSeverity.Information, 'vc-017-multiline-instance'));
    }
    const lines = new Set(instance.portConnections.map((connection) => connection.range.start.line));
    if (lines.size < instance.portConnections.length) {
      diagnostics.push(makeDiagnostic(instance.selectionRange, `VC-017: instance '${instance.instanceName}' should place each port connection on a separate line.`, DiagnosticSeverity.Information, 'vc-017-one-port-per-line'));
    }
  }
}

function collectDeclarationGroupingDiagnostics(document: TextDocument, text: string, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const bodyStart = document.offsetAt(module.headerEnd);
  const bodyEnd = document.offsetAt(module.range.end);
  const body = stripCommentsAndStrings(text.slice(bodyStart, bodyEnd));
  const firstStatement = /\b(?:assign|always|initial|generate|[A-Za-z_]\w*\s+(?:#\s*\()?|endmodule)\b/.exec(body);
  if (!firstStatement) {
    return;
  }
  const lateDecl = /\b(?:wire|reg|logic|integer|parameter|localparam|genvar)\b/.exec(body.slice(firstStatement.index + 1));
  if (lateDecl) {
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, bodyStart + firstStatement.index + 1 + lateDecl.index, lateDecl[0].length), 'VC-016: group internal declarations before module logic and instances.', DiagnosticSeverity.Information, 'vc-016-declaration-group'));
  }
}

function collectExplicitWidthDiagnostics(module: VerilogModule, diagnostics: Diagnostic[]): void {
  for (const decl of module.declarations.values()) {
    if (decl.kind === 'parameter' || decl.kind === 'localparam' || decl.kind === 'integer' || decl.kind === 'genvar') {
      continue;
    }
    if (!decl.width && !['clk', 'clock', 'reset', 'rst'].includes(decl.name.toLowerCase())) {
      diagnostics.push(makeDiagnostic(decl.selectionRange, `VC-021: signal '${decl.name}' should declare an explicit width, even if it is 1 bit.`, DiagnosticSeverity.Information, 'vc-021-explicit-width'));
    }
  }
}

function collectMagicNumberDiagnostics(document: TextDocument, text: string, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const bodyStart = document.offsetAt(module.headerEnd);
  const bodyEnd = document.offsetAt(module.range.end);
  const body = stripCommentsAndStrings(text.slice(bodyStart, bodyEnd));
  const numberRegex = /\b(?:\d+'\s*[sS]?[bBoOdDhH]\s*[0-9a-fA-F_xXzZ?]+|\d+)\b/g;
  let match: RegExpExecArray | null;
  while ((match = numberRegex.exec(body))) {
    const absolute = bodyStart + match.index;
    const line = document.positionAt(absolute).line;
    const lineText = lineAt(document, line).text;
    if (/\b(?:parameter|localparam)\b|`define/.test(lineText) || isTrivialLiteral(match[0]) || isInsideBracketRange(body, match.index)) {
      continue;
    }
    diagnostics.push(makeDiagnostic(rangeAtOffset(document, absolute, match[0].length), 'VC-004: replace magic numbers with a descriptive localparam, parameter, or macro.', DiagnosticSeverity.Information, 'vc-004-magic-number'));
  }
}

function collectWhitespaceDiagnostics(document: TextDocument, text: string, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const strippedText = stripCommentsAndStrings(text);
  for (let lineNumber = module.range.start.line; lineNumber <= module.range.end.line && lineNumber < document.lineCount; lineNumber++) {
    const original = lineAt(document, lineNumber).text;
    const lineOffset = document.offsetAt(Position.create(lineNumber, 0));
    const code = strippedText.slice(lineOffset, lineOffset + original.length);
    if (/,[^\s),]/.test(code)) {
      diagnostics.push(makeDiagnostic(Range.create(lineNumber, code.indexOf(','), lineNumber, code.indexOf(',') + 1), 'VC-018: add a space after commas.', DiagnosticSeverity.Information, 'vc-018-comma-space'));
    }
    const operator = /[^\s](?:<=|>=|==|!=|&&|\|\||[+\-*/%&|^=<>])[^\s=>]/.exec(code);
    if (operator) {
      diagnostics.push(makeDiagnostic(Range.create(lineNumber, operator.index, lineNumber, operator.index + operator[0].length), 'VC-018: put spaces around operators.', DiagnosticSeverity.Information, 'vc-018-operator-space'));
    }
    const trimmed = code.trim();
    if (trimmed && lineNumber > module.range.start.line && lineNumber < module.range.end.line && !/^\s/.test(original)) {
      diagnostics.push(makeDiagnostic(Range.create(lineNumber, 0, lineNumber, Math.min(1, original.length)), 'VC-020: indent module body contents.', DiagnosticSeverity.Information, 'vc-020-indent'));
    }
  }
}

function collectAbstractionDiagnostics(module: VerilogModule, diagnostics: Diagnostic[]): void {
  const lineCount = module.range.end.line - module.range.start.line + 1;
  if (lineCount > 300 || module.instances.length === 0 && lineCount > 160) {
    diagnostics.push(makeDiagnostic(module.selectionRange, 'VC-022: consider decomposing this complex module into smaller submodules.', DiagnosticSeverity.Information, 'vc-022-module-abstraction'));
  }
}

function collectInoutDiagnostics(settings: CoSettings, module: VerilogModule, diagnostics: Diagnostic[]): void {
  const topName = settings.project.topModule.trim() || 'mips';
  if (module.name === topName) {
    return;
  }
  for (const port of module.ports) {
    if (port.direction === 'inout') {
      diagnostics.push(makeDiagnostic(port.selectionRange, `VC-015: internal module '${module.name}' should not use inout port '${port.name}'.`, DiagnosticSeverity.Warning, 'vc-015-inout'));
    }
  }
}

function collectTestbenchDiagnostics(document: TextDocument, settings: CoSettings, text: string, modules: VerilogModule[], diagnostics: Diagnostic[]): void {
  for (const module of modules) {
    const isTestbench = module.name.toLowerCase().includes('tb') || module.name === settings.project.testbench;
    if (!isTestbench) {
      continue;
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const body = text.slice(bodyStart, bodyEnd);
    if (!/`timescale\s+1ns\s*\/\s*1ps/.test(text)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: standard course testbenches should use `timescale 1ns / 1ps.', DiagnosticSeverity.Information, 'tb-timescale'));
    }
    if (!/\bclk\b[\s\S]*(?:forever\s*#|#\s*\d+)[\s\S]*\bclk\s*=\s*~\s*clk/.test(body)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: include clk generation logic.', DiagnosticSeverity.Information, 'tb-clock'));
    }
    if (!/\breset\b/.test(body)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: include reset generation logic.', DiagnosticSeverity.Information, 'tb-reset'));
    }
    if (!/\$readmemh\s*\(\s*"code\.txt"/.test(body)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: use $readmemh("code.txt", im) to load machine code when simulating CPU projects.', DiagnosticSeverity.Information, 'tb-readmemh'));
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
  const strippedText = stripCommentsAndStrings(text);
  const displayRegex = /\$display\s*\(\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = displayRegex.exec(text))) {
    if (strippedText.slice(match.index, match.index + '$display'.length) !== '$display') {
      continue;
    }
    const format = match[1];
    const ok = profile === 'P5'
      ? /%d@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/.test(format)
      : /@%h:\s*(?:\$%d|\*%h)\s*<=\s*%h/.test(format);
    if (!ok) {
      diagnostics.push(makeDiagnostic(rangeAtOffset(document, match.index, '$display'.length), `${profile} $display format does not match the expected CPU trace format.`, DiagnosticSeverity.Warning, 'display-format'));
    }
  }
}

export function widthOfDecl(decl: VerilogDecl): WidthInfo {
  const rangeWidth = widthFromRange(decl.width);
  if (rangeWidth !== undefined) {
    return { width: rangeWidth };
  }
  if (decl.kind === 'integer' || decl.kind === 'time') {
    return { width: 32 };
  }
  return { width: 1 };
}

export function widthOfExpression(expression: string, module: VerilogModule): WidthInfo {
  let text = stripCommentsAndStrings(expression).trim();
  while (isWrappedByParens(text)) {
    text = text.slice(1, -1).trim();
  }
  if (!text) {
    return {};
  }

  const ternary = splitTernary(text);
  if (ternary) {
    return maxWidth(widthOfExpression(ternary.whenTrue, module), widthOfExpression(ternary.whenFalse, module));
  }

  if (text.startsWith('{') && text.endsWith('}')) {
    const inner = text.slice(1, -1).trim();
    const repeat = inner.match(/^(\d+)\s*\{([\s\S]*)\}$/);
    if (repeat) {
      const count = Number(repeat[1]);
      const repeated = widthOfExpression(repeat[2], module).width;
      return repeated !== undefined ? { width: count * repeated } : {};
    }
    let width = 0;
    for (const part of splitTopLevelCommaSpans(inner)) {
      const partWidth = widthOfExpression(part.text, module).width;
      if (partWidth === undefined) {
        return {};
      }
      width += partWidth;
    }
    return { width };
  }

  const shifted = splitTopLevelOperator(text, ['<<<', '>>>', '<<', '>>']);
  if (shifted) {
    return widthOfExpression(shifted.left, module);
  }

  const comparison = splitTopLevelOperator(text, ['==', '!=', '<=', '>=', '<', '>', '&&', '||']);
  if (comparison) {
    return { width: 1 };
  }

  const binary = splitTopLevelOperator(text, ['+', '-', '^', '|', '&', '*', '/', '%']);
  if (binary) {
    return maxWidth(widthOfExpression(binary.left, module), widthOfExpression(binary.right, module));
  }

  if (/^[!~&|^]+/.test(text)) {
    const operator = text.match(/^[!~&|^]+/)?.[0] ?? '';
    const operand = widthOfExpression(text.slice(operator.length), module);
    return operator === '~' ? operand : { width: 1 };
  }

  const rangeMatch = text.match(/^([A-Za-z_]\w*)\s*\[\s*(\d+)\s*(?::\s*(\d+)\s*)?\]$/);
  if (rangeMatch) {
    if (rangeMatch[3] !== undefined) {
      return { width: Math.abs(Number(rangeMatch[2]) - Number(rangeMatch[3])) + 1 };
    }
    return { width: 1 };
  }

  const literal = literalWidth(text);
  if (literal.width !== undefined) {
    return literal;
  }

  const identifier = text.match(/^[A-Za-z_]\w*$/);
  if (identifier) {
    const decl = module.declarations.get(identifier[0]);
    return decl ? widthOfDecl(decl) : {};
  }

  return {};
}

function widthFromRange(width?: string): number | undefined {
  if (!width) {
    return undefined;
  }
  const match = width.match(/^\[\s*(\d+)\s*:\s*(\d+)\s*\]$/);
  if (!match) {
    return undefined;
  }
  return Math.abs(Number(match[1]) - Number(match[2])) + 1;
}

function literalWidth(text: string): WidthInfo {
  const based = text.match(/^(\d+)?\s*'\s*[sS]?\s*([bBoOdDhH])\s*([0-9a-fA-F_xXzZ?]+)$/);
  if (based) {
    if (based[1]) {
      return { width: Number(based[1]) };
    }
    const digits = based[3].replace(/_/g, '');
    const base = based[2].toLowerCase();
    const bitsPerDigit = base === 'b' ? 1 : base === 'o' ? 3 : base === 'h' ? 4 : undefined;
    const minWidth = bitsPerDigit ? Math.max(1, digits.length * bitsPerDigit) : minimalBitsForDecimal(digits);
    return { width: Math.max(32, minWidth), minWidth, flexible: true };
  }
  if (/^\d+$/.test(text)) {
    const minWidth = minimalBitsForDecimal(text);
    return { width: Math.max(32, minWidth), minWidth, flexible: true };
  }
  return {};
}

function minimalBitsForDecimal(text: string): number {
  try {
    const value = BigInt(text);
    if (value === 0n) {
      return 1;
    }
    return value.toString(2).length;
  } catch {
    return 32;
  }
}

function maxWidth(left: WidthInfo, right: WidthInfo): WidthInfo {
  if (left.width === undefined) {
    return right;
  }
  if (right.width === undefined) {
    return left;
  }
  return {
    width: Math.max(left.width, right.width),
    minWidth: Math.max(left.minWidth ?? left.width, right.minWidth ?? right.width),
    flexible: left.flexible && right.flexible
  };
}

function collectAlwaysBlocks(document: TextDocument, text: string, module: VerilogModule): AlwaysBlockInfo[] {
  const blocks: AlwaysBlockInfo[] = [];
  const moduleStart = document.offsetAt(module.headerEnd);
  const moduleEnd = document.offsetAt(module.range.end);
  const moduleText = text.slice(moduleStart, moduleEnd);
  const stripped = stripCommentsAndStrings(moduleText);
  const alwaysRegex = /\balways\s*@\s*\(([\s\S]*?)\)\s*/g;
  let match: RegExpExecArray | null;
  while ((match = alwaysRegex.exec(stripped))) {
    const headerStart = moduleStart + match.index;
    const bodyOffset = moduleStart + match.index + match[0].length;
    const bodyInfo = findAlwaysBody(stripped, match.index + match[0].length);
    const endOffset = moduleStart + bodyInfo.end;
    const sensitivity = match[1];
    const sequential = /\b(?:posedge|negedge)\b/.test(sensitivity);
    blocks.push({
      sensitivity,
      range: Range.create(document.positionAt(headerStart), document.positionAt(endOffset)),
      headerRange: Range.create(document.positionAt(headerStart), document.positionAt(bodyOffset)),
      bodyText: text.slice(bodyOffset, endOffset),
      bodyOffset,
      sequential,
      combinational: !sequential,
    });
  }
  return blocks;
}

function findAlwaysBody(text: string, from: number): { end: number } {
  const start = skipWhitespace(text, from);
  if (/\bbegin\b/.test(text.slice(start, start + 12))) {
    const tokenRegex = /\b(begin|end)\b/g;
    tokenRegex.lastIndex = start;
    let depth = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(text))) {
      if (match[1] === 'begin') {
        depth++;
      } else {
        depth--;
        if (depth === 0) {
          return { end: tokenRegex.lastIndex };
        }
      }
    }
    return { end: text.length };
  }
  const semicolon = text.indexOf(';', start);
  return { end: semicolon >= 0 ? semicolon + 1 : text.length };
}

function collectAssignmentsInText(document: TextDocument, text: string, offset: number, blockIndex: number): AssignmentUse[] {
  const assignments: AssignmentUse[] = [];
  const stripped = stripCommentsAndStrings(text);
  const assignRegex = /\b([A-Za-z_]\w*)\s*(<=|=)(?!=)/g;
  let match: RegExpExecArray | null;
  while ((match = assignRegex.exec(stripped))) {
    if (isInsideForControl(stripped, match.index)) {
      continue;
    }
    assignments.push({
      name: match[1],
      operator: match[2] as '=' | '<=',
      range: rangeAtOffset(document, offset + match.index, match[0].length),
      blockIndex
    });
  }
  return assignments;
}

function identifierStyle(name: string): 'snake' | 'camel' | 'pascal' | undefined {
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) {
    return 'snake';
  }
  if (/^[a-z][A-Za-z0-9]*$/.test(name)) {
    return 'camel';
  }
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    return 'pascal';
  }
  return undefined;
}

function looksLowActiveWithoutSuffix(name: string): boolean {
  const lower = name.toLowerCase();
  return !lower.endsWith('_n') && /(?:^|_)(?:nreset|nrst|rstn|resetn|wen|webar|enbar)(?:_|$)/.test(lower);
}

function isTrivialLiteral(value: string): boolean {
  const normalized = value.replace(/\s+/g, '').toLowerCase();
  return normalized === '0' || normalized === '1' || /^\d+'[bodh]0+$/.test(normalized) || /^\d+'[bodh]1$/.test(normalized);
}

function isInsideBracketRange(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const lineEndRaw = text.indexOf('\n', index);
  const lineEnd = lineEndRaw >= 0 ? lineEndRaw : text.length;
  const before = text.slice(lineStart, index);
  const after = text.slice(index, lineEnd);
  return before.lastIndexOf('[') > before.lastIndexOf(']') && after.includes(']');
}

function isInsideForControl(text: string, offset: number): boolean {
  const prefix = text.slice(0, offset);
  const forMatch = /\bfor\s*\([^()]*$/m.exec(prefix);
  if (!forMatch) {
    return false;
  }
  const openOffset = prefix.lastIndexOf('(');
  if (openOffset < 0) {
    return false;
  }
  const closeOffset = findMatchingParen(text, openOffset);
  return closeOffset !== undefined && offset < closeOffset;
}

function isWrappedByParens(text: string): boolean {
  if (!text.startsWith('(') || !text.endsWith(')')) {
    return false;
  }
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0 && index < text.length - 1) {
        return false;
      }
    }
  }
  return depth === 0;
}

function splitTernary(text: string): { condition: string; whenTrue: string; whenFalse: string } | undefined {
  let depth = 0;
  let question = -1;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === '?' && depth === 0) {
      question = index;
      break;
    }
  }
  if (question < 0) {
    return undefined;
  }
  depth = 0;
  for (let index = question + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '(' || char === '[' || char === '{' || char === '?') {
      depth++;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ':' && depth === 0) {
      return {
        condition: text.slice(0, question),
        whenTrue: text.slice(question + 1, index),
        whenFalse: text.slice(index + 1)
      };
    }
  }
  return undefined;
}

function splitTopLevelOperator(text: string, operators: string[]): { left: string; operator: string; right: string } | undefined {
  let depth = 0;
  for (let index = text.length - 1; index >= 0; index--) {
    const char = text[index];
    if (char === ')' || char === ']' || char === '}') {
      depth++;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    for (const operator of operators) {
      const start = index - operator.length + 1;
      if (start <= 0 || text.slice(start, index + 1) !== operator) {
        continue;
      }
      const left = text.slice(0, start).trim();
      const right = text.slice(index + 1).trim();
      if (left && right) {
        return { left, operator, right };
      }
    }
  }
  return undefined;
}

function findEndmodule(text: string, from: number): EndmoduleInfo {
  const suffix = text.slice(from);
  const match = /\bendmodule\b/.exec(suffix);
  if (!match) {
    return {
      found: false,
      startOffset: text.length,
      endOffset: text.length
    };
  }
  const startOffset = from + match.index;
  return {
    found: true,
    startOffset,
    endOffset: startOffset + match[0].length
  };
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function readIdentifier(text: string, start: number): IdentifierToken | undefined {
  const match = /^[A-Za-z_]\w*/.exec(text.slice(start));
  if (!match) {
    return undefined;
  }
  return {
    value: match[0],
    start,
    end: start + match[0].length
  };
}

function skipWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) {
    index++;
  }
  return index;
}

function findMatchingParen(text: string, openIndex: number): number | undefined {
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    const char = text[index];
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function leadingWhitespaceLength(text: string): number {
  return text.length - text.trimStart().length;
}
