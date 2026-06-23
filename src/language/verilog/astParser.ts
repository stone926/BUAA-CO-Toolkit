import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangeAtOffset } from '../common/lsp';
import { VerilogCstDocument, parseVerilogCst } from './cst';
import { isIdentifierLike, VerilogToken } from './lexer';
import { splitVerilogModuleItems } from './statementUtils';
import {
  systemTasks,
  VerilogDecl,
  VerilogDeclKind,
  VerilogInstance,
  VerilogModule,
  VerilogPortConnection,
  verilogKeywords
} from './model';
import { widthOfExpressionAst, WidthInfo } from './expressions';
import { evalVerilogIntegerConstant, parseVerilogExpression, parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
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
const instanceExcludedFirstTokens = new Set([
  'module',
  'endmodule',
  'assign',
  'always',
  'initial',
  'begin',
  'end',
  'if',
  'else',
  'case',
  'casex',
  'casez',
  'endcase',
  'for',
  'forever',
  'repeat',
  'while',
  'task',
  'endtask',
  'function',
  'endfunction',
  'generate',
  'endgenerate'
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
    // task/function names, arguments and locals are not module ports/parameters, but they ARE
    // declared identifiers — register them (without promotion) so implicit-net / references don't
    // mis-report them. They never overwrite a real module-level declaration of the same name.
    for (const decl of parseSubroutineDeclarations(document, text, bodyTokens)) {
      if (!module.declarations.has(decl.name)) {
        module.declarations.set(decl.name, decl);
      }
    }
    inferModuleParameterConstants(module);
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
      const nameToken = declarationNameToken(part);
      if (!nameToken) {
        continue;
      }
      const initializer = declarationInitializerInfo(document, text, part);
      const inferred = (kind === 'parameter' || kind === 'localparam')
        ? initializer
        : {};
      declarations.push({
        name: nameToken.value,
        kind,
        width,
        initializer: initializer.initializer,
        initializerRange: initializer.initializerRange,
        initializerAst: initializer.initializerAst,
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

function parseSubroutineDeclarations(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  const result: VerilogDecl[] = [];
  for (const statement of statementSlices(tokens)) {
    const first = statement[0];
    if (!first || (first.value !== 'task' && first.value !== 'function')) {
      continue;
    }
    const kind = first.value as VerilogDeclKind; // 'task' | 'function'
    const endValue = first.value === 'task' ? 'endtask' : 'endfunction';
    const headerEnd = topLevelIndexOfValue(statement, ';', 1, statement.length);
    const headerLimit = headerEnd < 0 ? statement.length : headerEnd;
    const parenOpen = topLevelIndexOfValue(statement, '(', 1, headerLimit);
    const nameLimit = parenOpen < 0 ? headerLimit : parenOpen;
    const nameToken = lastIdentifierToken(statement, 1, nameLimit);
    if (nameToken) {
      result.push({
        name: nameToken.value,
        kind,
        range: Range.create(document.positionAt(statement[0].start), document.positionAt(statement[statement.length - 1].end)),
        selectionRange: tokenRange(document, nameToken)
      });
    }
    if (parenOpen >= 0) {
      const close = findMatchingToken(statement, parenOpen, '(', ')');
      if (close > parenOpen && close < headerLimit) {
        result.push(...subroutineArgumentDeclarations(document, text, statement.slice(parenOpen + 1, close)));
      }
    }
    if (headerEnd >= 0) {
      const endIndex = indexOfValueFrom(statement, endValue, headerEnd + 1);
      const body = statement.slice(headerEnd + 1, endIndex < 0 ? statement.length : endIndex);
      result.push(...parseBodyDeclarations(document, text, body));
      result.push(...parseSubroutineDeclarations(document, text, body));
    }
  }
  return result;
}

function subroutineArgumentDeclarations(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  const result: VerilogDecl[] = [];
  for (const part of splitTopLevel(tokens, ',')) {
    const nameToken = declarationNameToken(part);
    if (!nameToken) {
      continue;
    }
    // Arguments are task/function locals, not module ports — keep them as a non-port kind.
    result.push({
      name: nameToken.value,
      kind: 'reg',
      width: firstRangeText(text, part),
      range: Range.create(document.positionAt(part[0].start), document.positionAt(part[part.length - 1].end)),
      selectionRange: tokenRange(document, nameToken)
    });
  }
  return result;
}

function inferModuleParameterConstants(module: VerilogModule): void {
  const evaluating = new Set<string>();
  const resolve = (name: string): bigint | undefined => {
    const decl = module.declarations.get(name);
    if (!decl || !isConstantDecl(decl)) {
      return undefined;
    }
    if (decl.constantValue !== undefined) {
      return decl.constantValue;
    }
    if (!decl.initializer || evaluating.has(decl.name)) {
      return undefined;
    }
    evaluating.add(decl.name);
    try {
      const ast = decl.initializerAst ?? parseVerilogExpression(decl.initializer);
      const value = ast ? evalVerilogIntegerConstant(ast, resolve) : undefined;
      if (value !== undefined) {
        decl.constantValue = value;
      }
      return value;
    } finally {
      evaluating.delete(decl.name);
    }
  };

  for (const decl of module.parameters) {
    resolve(decl.name);
  }
  for (const decl of module.parameters) {
    if (!decl.initializer) {
      continue;
    }
    const inferred = widthOfExpressionAst(decl.initializerAst ?? parseVerilogExpression(decl.initializer), module);
    if (inferred.width !== undefined) {
      decl.inferredWidth = inferred.width;
      decl.inferredMinWidth = inferred.minWidth;
      decl.inferredFlexible = inferred.flexible;
    }
  }
}

function isConstantDecl(decl: VerilogDecl): boolean {
  return decl.kind === 'parameter' || decl.kind === 'localparam';
}

function topLevelIndexOfValue(tokens: VerilogToken[], value: string, from: number, to: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let index = from; index < to; index++) {
    const token = tokens[index];
    if (token.value === value && paren === 0 && bracket === 0 && brace === 0) {
      return index;
    }
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
  }
  return -1;
}

function lastIdentifierToken(tokens: VerilogToken[], from: number, to: number): VerilogToken | undefined {
  for (let index = Math.min(to, tokens.length) - 1; index >= from; index--) {
    const token = tokens[index];
    if (token.kind === 'identifier' && !verilogKeywords.has(token.value)) {
      return token;
    }
  }
  return undefined;
}

function indexOfValueFrom(tokens: VerilogToken[], value: string, from: number): number {
  for (let index = from; index < tokens.length; index++) {
    if (tokens[index].value === value) {
      return index;
    }
  }
  return -1;
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
  const initializer = declarationInitializerInfo(document, text, cleaned);
  const inferred = (kind === 'parameter' || kind === 'localparam')
    ? initializer
    : {};
  return {
    name: nameToken.value,
    kind,
    direction,
    width: firstRangeText(text, cleaned),
    initializer: initializer.initializer,
    initializerRange: initializer.initializerRange,
    initializerAst: initializer.initializerAst,
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
    if (!first || !isIdentifierLike(first.kind) || first.value === currentModuleName) {
      continue;
    }
    if (instanceExcludedFirstTokens.has(first.value)) {
      continue;
    }
    // 拒绝将声明关键字（reg, wire, input 等）误认为模块名来实例化
    if (first.kind === 'keyword' && declKinds.has(first.value)) {
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
    if (!instanceToken || !isIdentifierLike(instanceToken.kind)) {
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
    if (first.value === '.' && part[1] && isIdentifierLike(part[1].kind)) {
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
            expressionAst: parseVerilogExpressionTokens(expressionTokens),
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
        expressionAst: parseVerilogExpressionTokens(part),
        range: expressionRange,
        positionalIndex
      });
    }
    positionalIndex++;
  }
  return connections;
}

function statementSlices(tokens: VerilogToken[]): VerilogToken[][] {
  return splitVerilogModuleItems(tokens);
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
    return isIdentifierLike(token.kind) ? index : -1;
  }
  return -1;
}

function declarationNameToken(tokens: VerilogToken[]): VerilogToken | undefined {
  const index = firstDeclaratorIndex(tokens, 0);
  return index >= 0 ? tokens[index] : undefined;
}

interface DeclarationInitializerInfo extends WidthInfo {
  initializer?: string;
  initializerRange?: Range;
  initializerAst?: VerilogExpressionAst;
}

function declarationInitializerInfo(document: TextDocument, text: string, tokens: VerilogToken[]): DeclarationInitializerInfo {
  const equal = findTopLevelToken(tokens, '=');
  if (equal < 0) {
    return {};
  }
  const expressionTokens = tokens.slice(equal + 1).filter((token) => token.kind !== 'eof');
  if (!expressionTokens.length) {
    return {};
  }
  const initializer = tokenText(text, expressionTokens).trim();
  const initializerAst = parseVerilogExpressionTokens(expressionTokens);
  const width = widthOfExpressionAst(initializerAst, undefined);
  return {
    ...width,
    initializer,
    initializerAst,
    initializerRange: tokensRange(document, expressionTokens, tokens[equal].end, tokens[tokens.length - 1].end)
  };
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

function tokenText(text: string, tokens: VerilogToken[]): string {
  if (!tokens.length) {
    return '';
  }
  return text.slice(tokens[0].start, tokens[tokens.length - 1].end);
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
