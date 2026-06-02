import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangeAtOffset } from '../common/lsp';
import { VerilogCstDocument, parseVerilogCst } from './cst';
import { VerilogToken } from './lexer';
import {
  systemTasks,
  VerilogDecl,
  VerilogDeclKind,
  VerilogInstance,
  VerilogModule,
  VerilogPortConnection,
  verilogKeywords
} from './model';
import { widthOfConstantInitializer, WidthInfo } from './expressions';
import { normalizeWidth } from './textUtils';

interface ModuleHeaderInfo {
  moduleToken: VerilogToken;
  nameToken: VerilogToken;
  parameterTokens: VerilogToken[];
  headerTokens: VerilogToken[];
  bodyStartOffset: number;
  endmoduleToken?: VerilogToken;
  endOffset: number;
  nextIndex: number;
}

const portKinds = new Set(['input', 'output', 'inout']);
const declKinds = new Set([
  'input',
  'output',
  'inout',
  'wire',
  'reg',
  'logic',
  'integer',
  'real',
  'realtime',
  'time',
  'parameter',
  'localparam',
  'genvar'
]);
const declModifiers = new Set([
  'automatic',
  'signed',
  'unsigned',
  'tri',
  'tri0',
  'tri1',
  'supply0',
  'supply1'
]);

export function parseModulesFromCst(
  document: TextDocument,
  text: string,
  cst: VerilogCstDocument = parseVerilogCst(document, text)
): VerilogModule[] {
  const modules: VerilogModule[] = [];
  const tokens = cst.codeTokens;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.kind === 'eof') {
      break;
    }
    if (token.value !== 'module') {
      index++;
      continue;
    }
    const header = readModuleHeader(tokens, index, text);
    if (!header) {
      index++;
      continue;
    }

    const module: VerilogModule = {
      name: header.nameToken.value,
      ports: [],
      parameters: [],
      declarations: new Map(),
      instances: [],
      range: Range.create(document.positionAt(header.moduleToken.start), document.positionAt(header.endOffset)),
      selectionRange: tokenRange(document, header.nameToken),
      headerEnd: document.positionAt(header.bodyStartOffset),
      uri: document.uri,
      bodyText: text.slice(header.bodyStartOffset, header.endOffset),
      hasEndmodule: Boolean(header.endmoduleToken),
      endmoduleRange: header.endmoduleToken ? tokenRange(document, header.endmoduleToken) : undefined
    };

    for (const param of parseParameterDeclarations(document, text, header.parameterTokens)) {
      module.parameters.push(param);
      module.declarations.set(param.name, param);
    }
    for (const port of parseHeaderPorts(document, text, header.headerTokens)) {
      module.ports.push(port);
      module.declarations.set(port.name, port);
    }

    const bodyTokens = tokens.filter((item) => item.start >= header.bodyStartOffset && item.start < (header.endmoduleToken?.start ?? header.endOffset));
    for (const decl of parseBodyDeclarations(document, text, bodyTokens)) {
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

    module.instances = parseInstances(document, text, bodyTokens, module.name);
    modules.push(module);
    index = header.nextIndex;
  }
  return modules;
}

function readModuleHeader(tokens: VerilogToken[], moduleIndex: number, text: string): ModuleHeaderInfo | undefined {
  const moduleToken = tokens[moduleIndex];
  const nameToken = nextCodeToken(tokens, moduleIndex + 1);
  if (!nameToken || nameToken.kind !== 'identifier') {
    return undefined;
  }
  let index = tokens.indexOf(nameToken) + 1;
  let parameterTokens: VerilogToken[] = [];
  let headerTokens: VerilogToken[] = [];

  if (tokens[index]?.value === '#') {
    if (tokens[index + 1]?.value !== '(') {
      return undefined;
    }
    const close = findMatchingToken(tokens, index + 1, '(', ')');
    if (close < 0) {
      return undefined;
    }
    parameterTokens = tokens.slice(index + 2, close);
    index = close + 1;
  }

  if (tokens[index]?.value === '(') {
    const close = findMatchingToken(tokens, index, '(', ')');
    if (close < 0) {
      return undefined;
    }
    headerTokens = tokens.slice(index + 1, close);
    index = close + 1;
  }

  if (tokens[index]?.value !== ';') {
    return undefined;
  }
  const bodyStartOffset = tokens[index].end;
  const endmoduleIndex = findEndmoduleToken(tokens, index + 1);
  const endmoduleToken = endmoduleIndex >= 0 ? tokens[endmoduleIndex] : undefined;
  return {
    moduleToken,
    nameToken,
    parameterTokens,
    headerTokens,
    bodyStartOffset,
    endmoduleToken,
    endOffset: endmoduleToken?.end ?? text.length,
    nextIndex: endmoduleIndex >= 0 ? endmoduleIndex + 1 : tokens.length
  };
}

function parseHeaderPorts(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  const ports: VerilogDecl[] = [];
  let inheritedDirection: 'input' | 'output' | 'inout' | undefined;
  let inheritedWidth: string | undefined;
  for (const part of splitTopLevel(tokens, ',')) {
    const port = parseDeclFragment(document, text, part, 'wire');
    if (!port) {
      continue;
    }
    const direction = firstTokenValue(part, portKinds) as 'input' | 'output' | 'inout' | undefined;
    const width = firstRangeText(text, part);
    if (direction) {
      port.direction = direction;
      port.kind = direction;
      port.width = width ?? port.width;
      inheritedDirection = direction;
      inheritedWidth = width;
    } else if (inheritedDirection) {
      port.direction = inheritedDirection;
      port.kind = inheritedDirection;
      if (!port.width && inheritedWidth) {
        port.width = inheritedWidth;
      }
    }
    ports.push(port);
  }
  return ports;
}

function parseParameterDeclarations(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  return splitTopLevel(tokens, ',')
    .map((part) => parseDeclFragment(document, text, part, 'parameter'))
    .filter((decl): decl is VerilogDecl => Boolean(decl));
}

function parseBodyDeclarations(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  const declarations: VerilogDecl[] = [];
  for (const statement of statementSlices(tokens)) {
    const first = statement[0];
    if (!first || !declKinds.has(first.value)) {
      continue;
    }
    const semicolonTrimmed = trimTrailingSemicolon(statement);
    const firstName = firstDeclaratorIndex(semicolonTrimmed, 1);
    if (firstName < 0) {
      continue;
    }
    const prefix = semicolonTrimmed.slice(0, firstName);
    const kind = first.value as VerilogDeclKind;
    const width = lastRangeText(text, prefix);
    for (const part of splitTopLevel(semicolonTrimmed.slice(firstName), ',')) {
      const nameToken = part.find((token) => token.kind === 'identifier');
      if (!nameToken) {
        continue;
      }
      const inferred = (kind === 'parameter' || kind === 'localparam')
        ? inferredWidthOfDeclarationInitializer(text, part)
        : {};
      declarations.push({
        name: nameToken.value,
        kind,
        width,
        inferredWidth: inferred.width,
        inferredMinWidth: inferred.minWidth,
        inferredFlexible: inferred.flexible,
        direction: isPortKind(kind) ? kind : undefined,
        range: Range.create(document.positionAt(statement[0].start), document.positionAt(statement[statement.length - 1].end)),
        selectionRange: tokenRange(document, nameToken)
      });
    }
  }
  return declarations;
}

function parseDeclFragment(document: TextDocument, text: string, tokens: VerilogToken[], fallbackKind: VerilogDeclKind): VerilogDecl | undefined {
  const cleaned = trimTrailingSemicolon(tokens);
  const nameToken = declarationNameToken(cleaned);
  if (!nameToken) {
    return undefined;
  }
  const direction = firstTokenValue(cleaned, portKinds) as 'input' | 'output' | 'inout' | undefined;
  const explicitKind = firstTokenValue(cleaned, declKinds) as VerilogDeclKind | undefined;
  const kind = (direction ?? explicitKind ?? fallbackKind) as VerilogDeclKind;
  const inferred = (kind === 'parameter' || kind === 'localparam')
    ? inferredWidthOfDeclarationInitializer(text, cleaned)
    : {};
  return {
    name: nameToken.value,
    kind,
    direction,
    width: firstRangeText(text, cleaned),
    inferredWidth: inferred.width,
    inferredMinWidth: inferred.minWidth,
    inferredFlexible: inferred.flexible,
    range: tokens.length ? Range.create(document.positionAt(tokens[0].start), document.positionAt(tokens[tokens.length - 1].end)) : tokenRange(document, nameToken),
    selectionRange: tokenRange(document, nameToken)
  };
}

function parseInstances(document: TextDocument, text: string, tokens: VerilogToken[], currentModuleName: string): VerilogInstance[] {
  const instances: VerilogInstance[] = [];
  for (const statement of statementSlices(tokens)) {
    const first = statement[0];
    if (!first || first.kind !== 'identifier' || first.value === currentModuleName || verilogKeywords.has(first.value) || systemTasks.has(first.value)) {
      continue;
    }
    let index = 1;
    let parameterConnections: VerilogPortConnection[] = [];
    let parameterListRange: Range | undefined;
    if (statement[index]?.value === '#') {
      if (statement[index + 1]?.value !== '(') {
        continue;
      }
      const close = findMatchingToken(statement, index + 1, '(', ')');
      if (close < 0) {
        continue;
      }
      const content = statement.slice(index + 2, close);
      parameterConnections = parseConnectionList(document, text, content);
      parameterListRange = listRange(document, statement[index + 1], statement[close]);
      index = close + 1;
    }
    const instanceToken = statement[index];
    if (!instanceToken || instanceToken.kind !== 'identifier') {
      continue;
    }
    index++;
    const moduleSelectionRange = tokenRange(document, first);
    const selectionRange = tokenRange(document, instanceToken);
    if (statement[index]?.value === ';') {
      instances.push({
        moduleName: first.value,
        instanceName: instanceToken.value,
        range: Range.create(document.positionAt(first.start), document.positionAt(statement[statement.length - 1].end)),
        moduleSelectionRange,
        selectionRange,
        parameterListRange,
        portConnections: [],
        parameterConnections
      });
      continue;
    }
    if (statement[index]?.value !== '(') {
      continue;
    }
    const close = findMatchingToken(statement, index, '(', ')');
    if (close < 0 || statement[close + 1]?.value !== ';') {
      continue;
    }
    const content = statement.slice(index + 1, close);
    instances.push({
      moduleName: first.value,
      instanceName: instanceToken.value,
      range: Range.create(document.positionAt(first.start), document.positionAt(statement[statement.length - 1].end)),
      moduleSelectionRange,
      selectionRange,
      portListRange: content.length ? Range.create(document.positionAt(content[0].start), document.positionAt(content[content.length - 1].end)) : Range.create(document.positionAt(statement[index].end), document.positionAt(statement[index].end)),
      parameterListRange,
      portConnections: parseConnectionList(document, text, content),
      parameterConnections
    });
  }
  return instances;
}

function parseConnectionList(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogPortConnection[] {
  const connections: VerilogPortConnection[] = [];
  let positionalIndex = 0;
  for (const part of splitTopLevel(tokens, ',')) {
    const first = part[0];
    if (!first) {
      continue;
    }
    if (first.value === '.' && part[1]?.kind === 'identifier') {
      const nameToken = part[1];
      if (part[2]?.value === '(') {
        const close = findMatchingToken(part, 2, '(', ')');
        if (close >= 0) {
          const expressionTokens = part.slice(3, close);
          const expressionRange = tokensRange(document, expressionTokens, part[2].end, part[close].start);
          connections.push({
            name: nameToken.value,
            nameRange: tokenRange(document, nameToken),
            expression: text.slice(document.offsetAt(expressionRange.start), document.offsetAt(expressionRange.end)),
            expressionRange,
            range: Range.create(document.positionAt(first.start), document.positionAt(part[part.length - 1].end)),
            positionalIndex
          });
        }
      } else {
        const end = part[part.length - 1].end;
        connections.push({
          name: nameToken.value,
          nameRange: tokenRange(document, nameToken),
          expression: '',
          expressionRange: Range.create(document.positionAt(end), document.positionAt(end)),
          range: Range.create(document.positionAt(first.start), document.positionAt(end)),
          positionalIndex,
          shorthand: true
        });
      }
    } else {
      const expressionRange = tokensRange(document, part, first.start, part[part.length - 1].end);
      connections.push({
        expression: text.slice(document.offsetAt(expressionRange.start), document.offsetAt(expressionRange.end)).trim(),
        expressionRange,
        range: expressionRange,
        positionalIndex
      });
    }
    positionalIndex++;
  }
  return connections;
}

function statementSlices(tokens: VerilogToken[]): VerilogToken[][] {
  const statements: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    }
    if (token.value === ';' && paren === 0 && bracket === 0 && brace === 0) {
      statements.push(tokens.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < tokens.length) {
    statements.push(tokens.slice(start));
  }
  return statements;
}

function splitTopLevel(tokens: VerilogToken[], separator: string): VerilogToken[][] {
  const parts: VerilogToken[][] = [];
  let start = 0;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    }
    if (token.value === separator && paren === 0 && bracket === 0 && brace === 0) {
      parts.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(tokens.slice(start));
  return parts.map(trimTokenList).filter((part) => part.length > 0);
}

function firstDeclaratorIndex(tokens: VerilogToken[], from: number): number {
  let index = from;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return -1;
      }
      index = close + 1;
      continue;
    }
    if (token.kind === 'keyword' && (declKinds.has(token.value) || declModifiers.has(token.value))) {
      index++;
      continue;
    }
    return token.kind === 'identifier' ? index : -1;
  }
  return -1;
}

function declarationNameToken(tokens: VerilogToken[]): VerilogToken | undefined {
  const index = firstDeclaratorIndex(tokens, 0);
  return index >= 0 ? tokens[index] : undefined;
}

function inferredWidthOfDeclarationInitializer(text: string, tokens: VerilogToken[]): WidthInfo {
  const equal = findTopLevelToken(tokens, '=');
  if (equal < 0) {
    return {};
  }
  return widthOfConstantInitializer(text.slice(tokens[equal].end, tokens[tokens.length - 1].end).trim());
}

function findTopLevelToken(tokens: VerilogToken[], value: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.value === '(') {
      paren++;
    } else if (token.value === ')') {
      paren = Math.max(0, paren - 1);
    } else if (token.value === '[') {
      bracket++;
    } else if (token.value === ']') {
      bracket = Math.max(0, bracket - 1);
    } else if (token.value === '{') {
      brace++;
    } else if (token.value === '}') {
      brace = Math.max(0, brace - 1);
    } else if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
  }
  return -1;
}

function firstRangeText(text: string, tokens: VerilogToken[]): string | undefined {
  const open = tokens.findIndex((token) => token.value === '[');
  if (open < 0) {
    return undefined;
  }
  const close = findMatchingToken(tokens, open, '[', ']');
  return close >= 0 ? normalizeWidth(text.slice(tokens[open].start, tokens[close].end)) : undefined;
}

function lastRangeText(text: string, tokens: VerilogToken[]): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== '[') {
      continue;
    }
    const close = findMatchingToken(tokens, index, '[', ']');
    if (close >= 0) {
      result = normalizeWidth(text.slice(tokens[index].start, tokens[close].end));
      index = close;
    }
  }
  return result;
}

function firstTokenValue(tokens: VerilogToken[], values: Set<string>): string | undefined {
  return tokens.find((token) => values.has(token.value))?.value;
}

function findEndmoduleToken(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === 'endmodule') {
      return index;
    }
  }
  return -1;
}

function findMatchingToken(tokens: VerilogToken[], openIndex: number, openValue: string, closeValue: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === openValue) {
      depth++;
    } else if (tokens[index].value === closeValue) {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function nextCodeToken(tokens: VerilogToken[], start: number): VerilogToken | undefined {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].kind !== 'eof') {
      return tokens[index];
    }
  }
  return undefined;
}

function tokenRange(document: TextDocument, token: VerilogToken): Range {
  return Range.create(document.positionAt(token.start), document.positionAt(token.end));
}

function listRange(document: TextDocument, open: VerilogToken, close: VerilogToken): Range {
  return Range.create(document.positionAt(open.start + 1), document.positionAt(close.start));
}

function tokensRange(document: TextDocument, tokens: VerilogToken[], fallbackStart: number, fallbackEnd: number): Range {
  if (!tokens.length) {
    return rangeAtOffset(document, fallbackStart, Math.max(0, fallbackEnd - fallbackStart));
  }
  return Range.create(document.positionAt(tokens[0].start), document.positionAt(tokens[tokens.length - 1].end));
}

function trimTrailingSemicolon(tokens: VerilogToken[]): VerilogToken[] {
  return tokens[tokens.length - 1]?.value === ';' ? tokens.slice(0, -1) : tokens;
}

function trimTokenList(tokens: VerilogToken[]): VerilogToken[] {
  return tokens.filter((token) => token.kind !== 'eof');
}

function isPortKind(kind: VerilogDeclKind): kind is 'input' | 'output' | 'inout' {
  return kind === 'input' || kind === 'output' || kind === 'inout';
}
