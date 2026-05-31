import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { widthOfConstantInitializer, WidthInfo } from './expressions';
import { parseInstances } from './instanceParser';
import {
  VerilogDecl,
  VerilogDeclKind,
  VerilogModule
} from './model';
import {
  findMatchingParen,
  leadingWhitespaceLength,
  normalizeWidth,
  skipWhitespace,
  splitTopLevelCommaSpans,
  stripCommentsAndStrings,
  topLevelAssignmentEquals
} from './textUtils';

interface EndmoduleInfo {
  found: boolean;
  startOffset: number;
  endOffset: number;
}

interface ModuleHeader {
  name: string;
  moduleOffset: number;
  nameOffset: number;
  bodyStartOffset: number;
  parameterText: string;
  parameterOffset: number;
  headerText: string;
  headerOffset: number;
}

export function parseModules(document: TextDocument, text: string): VerilogModule[] {
  const modules: VerilogModule[] = [];
  const searchable = stripCommentsAndStrings(text);
  for (const header of scanModuleHeaders(searchable)) {
    const endmodule = findEndmodule(searchable, header.bodyStartOffset);
    const module: VerilogModule = {
      name: header.name,
      ports: [],
      parameters: [],
      declarations: new Map(),
      instances: [],
      range: Range.create(document.positionAt(header.moduleOffset), document.positionAt(endmodule.endOffset)),
      selectionRange: Range.create(document.positionAt(header.nameOffset), document.positionAt(header.nameOffset + header.name.length)),
      headerEnd: document.positionAt(header.bodyStartOffset),
      uri: document.uri,
      bodyText: text.slice(header.bodyStartOffset, endmodule.endOffset),
      hasEndmodule: endmodule.found,
      endmoduleRange: endmodule.found
        ? Range.create(document.positionAt(endmodule.startOffset), document.positionAt(endmodule.endOffset))
        : undefined
    };

    for (const param of parseParameterDeclarations(document, header.parameterText, header.parameterOffset)) {
      module.parameters.push(param);
      module.declarations.set(param.name, param);
    }

    for (const port of parseHeaderPorts(document, header.headerText, header.headerOffset)) {
      module.ports.push(port);
      module.declarations.set(port.name, port);
    }

    for (const decl of parseDeclarations(document, text, header.bodyStartOffset, endmodule.startOffset)) {
      const existing = module.declarations.get(decl.name);
      if (existing && isPortKind(decl.kind)) {
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
        if (isPortKind(decl.kind)) {
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

    module.instances = parseInstances(document, text, header.bodyStartOffset, endmodule.startOffset, module.name);
    modules.push(module);
  }
  return modules;
}

function scanModuleHeaders(searchable: string): ModuleHeader[] {
  const headers: ModuleHeader[] = [];
  const moduleRegex = /\bmodule\s+([A-Za-z_]\w*)/g;
  let match: RegExpExecArray | null;
  while ((match = moduleRegex.exec(searchable))) {
    const header = readModuleHeader(searchable, match);
    if (!header) {
      continue;
    }
    headers.push(header);
    moduleRegex.lastIndex = header.bodyStartOffset;
  }
  return headers;
}

function readModuleHeader(searchable: string, match: RegExpExecArray): ModuleHeader | undefined {
  const name = match[1];
  const nameOffset = match.index + match[0].lastIndexOf(name);
  let position = skipWhitespace(searchable, nameOffset + name.length);
  let parameterText = '';
  let parameterOffset = -1;
  let headerText = '';
  let headerOffset = position;

  if (searchable[position] === '#') {
    position = skipWhitespace(searchable, position + 1);
    if (searchable[position] !== '(') {
      return undefined;
    }
    const close = findMatchingParen(searchable, position);
    if (close === undefined) {
      return undefined;
    }
    parameterOffset = position + 1;
    parameterText = searchable.slice(parameterOffset, close);
    position = skipWhitespace(searchable, close + 1);
  }

  if (searchable[position] === '(') {
    const close = findMatchingParen(searchable, position);
    if (close === undefined) {
      return undefined;
    }
    headerOffset = position + 1;
    headerText = searchable.slice(headerOffset, close);
    position = skipWhitespace(searchable, close + 1);
  }

  if (searchable[position] !== ';') {
    return undefined;
  }

  return {
    name,
    moduleOffset: match.index,
    nameOffset,
    bodyStartOffset: position + 1,
    parameterText,
    parameterOffset,
    headerText,
    headerOffset
  };
}

function parseHeaderPorts(document: TextDocument, header: string, headerOffset: number): VerilogDecl[] {
  const ports: VerilogDecl[] = [];
  const parts = splitTopLevelCommaSpans(header);
  let inheritedDirection: 'input' | 'output' | 'inout' | undefined;
  let inheritedWidth: string | undefined;
  for (const part of parts) {
    const trimmed = part.text.trim();
    const directionMatch = trimmed.match(/^(input|output|inout)\b/);
    const widthMatch = trimmed.match(/\[[^\]]+\]/);
    const port = parseDeclFragment(document, part.text, headerOffset + part.start);
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
    const inferred = inferredWidthOfDeclarationInitializer(trimmed);
    const name = match[3];
    const nameOffset = parameterOffset + part.start + leading + match[0].lastIndexOf(name);
    parameters.push({
      name,
      kind,
      width,
      inferredWidth: inferred.width,
      inferredMinWidth: inferred.minWidth,
      inferredFlexible: inferred.flexible,
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
      const inferred = (kind === 'parameter' || kind === 'localparam')
        ? inferredWidthOfDeclarationInitializer(trimmed)
        : {};
      declarations.push({
        name,
        kind,
        width,
        inferredWidth: inferred.width,
        inferredMinWidth: inferred.minWidth,
        inferredFlexible: inferred.flexible,
        direction: isPortKind(kind) ? kind : undefined,
        range: Range.create(document.positionAt(startOffset + match.index), document.positionAt(startOffset + match.index + match[0].length)),
        selectionRange: Range.create(document.positionAt(absoluteNameOffset), document.positionAt(absoluteNameOffset + name.length))
      });
    }
  }
  return declarations;
}

function parseDeclFragment(document: TextDocument, fragment: string, fragmentOffset: number): VerilogDecl | undefined {
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

function inferredWidthOfDeclarationInitializer(fragment: string): WidthInfo {
  const initializer = declarationInitializer(fragment);
  if (!initializer) {
    return {};
  }
  return widthOfConstantInitializer(initializer);
}

function declarationInitializer(fragment: string): string | undefined {
  const equal = topLevelAssignmentEquals(fragment);
  if (equal < 0) {
    return undefined;
  }
  return fragment.slice(equal + 1).trim();
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

function isPortKind(kind: VerilogDeclKind): kind is 'input' | 'output' | 'inout' {
  return kind === 'input' || kind === 'output' || kind === 'inout';
}
