import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { containsRange, rangeAtOffset } from '../common/lsp';
import { objectMacroExpressionsFromTokens } from './preprocessor';
import { isIdentifierLike, lexVerilog, VerilogToken } from './lexer';
import { splitVerilogModuleItems } from './statementUtils';
import { parseInstanceGroup } from './instanceParser';
import { generateItemEnd } from './generateBoundary';
import { splitTopLevelTokens as splitTopLevel } from './tokenUtils';
import { stripDriveStrength } from './driveStrength';
import { verilogCodeTokens } from './directiveBoundaries';
import {
  VerilogDecl,
  VerilogDeclDimension,
  VerilogDeclKind,
  VerilogGenerateBlock,
  VerilogGenerateBranch,
  VerilogInstance,
  VerilogModule,
  VerilogSubroutineSignature,
  verilogKeywords
} from './model';
import { convertConstantForDecl, evalExpressionAstConstant, widthOfExpressionAst, WidthInfo } from './expressions';
import { parseVerilogExpression, parseVerilogExpressionTokens, VerilogExpressionAst } from './exprAst';
import { normalizeWidth } from './textUtils';
import {
  normalizeVerilogDeclKind,
  verilogDeclarationKeywords,
  verilogDeclarationModifiers,
  verilogExplicitPortNetTypes,
  verilogPortDeclarationTypes,
  verilogPortDirections
} from './declarations';

interface ModuleHeaderInfo {
  moduleToken: VerilogToken;
  nameToken: VerilogToken;
  parameterTokens: VerilogToken[];
  headerTokens: VerilogToken[];
  bodyStartOffset: number;
  endmoduleToken?: VerilogToken;
  endOffset: number;
  nextIndex: number;
  hasCompleteHeader: boolean;
}

export function parseModulesFromTokens(
  document: TextDocument,
  text: string,
  tokens: VerilogToken[],
  macroExpressions = objectMacroExpressionsFromTokens(text, lexVerilog(text).tokens)
): VerilogModule[] {
  tokens = verilogCodeTokens(text, tokens);
  const modules: VerilogModule[] = [];
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
      declarationRecords: [],
      instances: [],
      generateBlocks: [],
      macroExpressions,
      range: Range.create(document.positionAt(header.moduleToken.start), document.positionAt(header.endOffset)),
      selectionRange: tokenRange(document, header.nameToken),
      headerEnd: document.positionAt(header.bodyStartOffset),
      uri: document.uri,
      bodyText: text.slice(header.bodyStartOffset, header.endOffset),
      hasEndmodule: Boolean(header.endmoduleToken),
      hasCompleteHeader: header.hasCompleteHeader,
      endmoduleRange: header.endmoduleToken ? tokenRange(document, header.endmoduleToken) : undefined
    };

    for (const param of parseParameterDeclarations(document, text, header.parameterTokens)) {
      module.declarationRecords!.push(param);
      module.parameters.push(param);
      module.declarations.set(param.name, param);
    }
    for (const port of parseHeaderPorts(document, text, header.headerTokens)) {
      module.declarationRecords!.push(port);
      module.ports.push(port);
      module.declarations.set(port.name, port);
    }

    const bodyTokens = tokens.filter((item) => item.start >= header.bodyStartOffset && item.start < (header.endmoduleToken?.start ?? header.endOffset));
    for (const decl of parseVerilogDeclarationTokens(document, text, bodyTokens)) {
      module.declarationRecords!.push(decl);
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
    module.generateBlocks = parseGenerateBlocks(document, text, bodyTokens);
    module.subroutines = parseSubroutineSignatures(document, text, bodyTokens);
    for (const signature of module.subroutines) {
      if (!module.generateBlocks.some((block) => containsRange(block.range, signature.range)) && !module.declarations.has(signature.name)) {
        module.declarations.set(signature.name, signature.declaration);
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
  let hasCompleteHeader = true;

  if (tokens[index]?.value === '#') {
    if (tokens[index + 1]?.value !== '(') {
      return undefined;
    }
    const close = moduleHeaderListEnd(tokens, index + 1);
    hasCompleteHeader &&= tokens[close]?.value === ')';
    parameterTokens = tokens.slice(index + 2, close);
    index = tokens[close]?.value === ')' ? close + 1 : close;
  }

  if (tokens[index]?.value === '(') {
    const close = moduleHeaderListEnd(tokens, index);
    hasCompleteHeader &&= tokens[close]?.value === ')';
    headerTokens = tokens.slice(index + 1, close);
    index = tokens[close]?.value === ')' ? close + 1 : close;
  }

  hasCompleteHeader &&= tokens[index]?.value === ';';
  const bodyStartOffset = tokens[index]?.value === ';' ? tokens[index].end : (tokens[index]?.start ?? text.length);
  const endmoduleIndex = findEndmoduleToken(tokens, tokens[index]?.value === ';' ? index + 1 : index);
  const endmoduleToken = endmoduleIndex >= 0 ? tokens[endmoduleIndex] : undefined;
  const nextModuleIndex = endmoduleToken ? -1 : tokens.findIndex((token, cursor) => cursor >= index && token.value === 'module');
  const recoveryEnd = nextModuleIndex >= 0 ? tokens[nextModuleIndex].start : text.length;
  return {
    moduleToken,
    nameToken,
    parameterTokens,
    headerTokens,
    bodyStartOffset,
    hasCompleteHeader,
    endmoduleToken,
    endOffset: endmoduleToken?.end ?? recoveryEnd,
    nextIndex: endmoduleIndex >= 0 ? endmoduleIndex + 1 : nextModuleIndex >= 0 ? nextModuleIndex : tokens.length
  };
}

function parseHeaderPorts(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  const ports: VerilogDecl[] = [];
  let inheritedDirection: 'input' | 'output' | 'inout' | undefined;
  let inheritedWidth: DeclarationWidthInfo | undefined;
  let inheritedExplicitPortNetType: boolean | undefined;
  let inheritedDirectionRange: Range | undefined;
  let inheritedType: Partial<VerilogDecl> = {};
  for (const part of splitTopLevel(tokens, ',')) {
    const port = parseDeclFragment(document, text, part, 'wire');
    if (!port) {
      continue;
    }
    const direction = firstTokenValue(part, verilogPortDirections) as 'input' | 'output' | 'inout' | undefined;
    const width = firstRangeInfo(document, text, part);
    if (direction) {
      port.direction = direction;
      port.kind = direction;
      applyDeclarationWidth(port, width);
      inheritedType = declarationTypeInfo(part.slice(0, part.indexOf(declarationNameToken(part)!)));
      inheritedDirection = direction;
      inheritedWidth = width;
      inheritedExplicitPortNetType = port.explicitPortNetType;
      inheritedDirectionRange = port.directionRange;
    } else if (inheritedDirection) {
      Object.assign(port, inheritedType);
      port.direction = inheritedDirection;
      port.kind = inheritedDirection;
      port.directionRange = inheritedDirectionRange;
      port.explicitPortNetType = inheritedExplicitPortNetType;
      if (!port.width && inheritedWidth) {
        applyDeclarationWidth(port, inheritedWidth);
      }
    }
    port.headerPlaceholder = !port.direction;
    ports.push(port);
  }
  return ports;
}

function parseParameterDeclarations(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  const declarations: VerilogDecl[] = [];
  let inheritedWidth: DeclarationWidthInfo | undefined;
  let inheritedKind: VerilogDeclKind = 'parameter';
  let inheritedType: Partial<VerilogDecl> = {};
  for (const part of splitTopLevel(tokens, ',')) {
    const decl = parseDeclFragment(document, text, part, inheritedKind);
    if (!decl) {
      continue;
    }
    if (part[0]?.value === 'parameter' || part[0]?.value === 'localparam') {
      inheritedWidth = firstRangeInfo(document, text, part);
      inheritedKind = decl.kind;
      inheritedType = declarationTypeInfo(part.slice(0, part.indexOf(declarationNameToken(part)!)));
    } else {
      Object.assign(decl, inheritedType);
      if (!decl.width && inheritedWidth) applyDeclarationWidth(decl, inheritedWidth);
    }
    declarations.push(decl);
  }
  return declarations;
}

export function parseVerilogDeclarationTokens(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogDecl[] {
  const declarations: VerilogDecl[] = [];
  for (const statement of statementSlices(tokens)) {
    const first = statement[0];
    if (!first || !verilogDeclarationKeywords.has(first.value)) {
      continue;
    }
    const semicolonTrimmed = stripDriveStrength(trimTrailingSemicolon(statement));
    const firstName = firstDeclaratorIndex(semicolonTrimmed, 1);
    if (firstName < 0) {
      continue;
    }
    const prefix = semicolonTrimmed.slice(0, firstName);
    const kind = normalizeVerilogDeclKind(first.value);
    const width = lastRangeInfo(document, text, prefix);
    for (const part of splitTopLevel(semicolonTrimmed.slice(firstName), ',')) {
      const nameToken = declarationNameToken(part);
      if (!nameToken) {
        continue;
      }
      const initializer = declarationInitializerInfo(document, text, part);
      const unpackedDimensions = declarationDimensionInfos(document, text, part, nameToken);
      const inferred = (kind === 'parameter' || kind === 'localparam')
        ? initializer
        : {};
      const directionRange = isPortKind(kind) ? tokenRange(document, first) : undefined;
      declarations.push({
        name: nameToken.value,
        kind,
        ...declarationTypeInfo(prefix),
        width: width?.width,
        widthRange: width?.widthRange,
        widthAst: width?.widthAst,
        unpackedDimensions: unpackedDimensions.length ? unpackedDimensions : undefined,
        initializer: initializer.initializer,
        initializerRange: initializer.initializerRange,
        initializerAst: initializer.initializerAst,
        inferredWidth: inferred.width,
        inferredMinWidth: inferred.minWidth,
        inferredFlexible: inferred.flexible,
        direction: isPortKind(kind) ? kind : undefined,
        directionRange,
        explicitPortNetType: isPortKind(kind) ? hasExplicitPortNetTypeInTokens(semicolonTrimmed, 0) : undefined,
        range: Range.create(document.positionAt(statement[0].start), document.positionAt(statement[statement.length - 1].end)),
        selectionRange: tokenRange(document, nameToken)
      });
    }
  }
  return declarations;
}

function parseSubroutineSignatures(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogSubroutineSignature[] {
  const result: VerilogSubroutineSignature[] = [];
  for (const statement of statementSlices(tokens)) {
    const first = statement[0];
    if (!first || (first.value !== 'task' && first.value !== 'function')) {
      for (const nested of nestedGenerateItems(statement)) result.push(...parseSubroutineSignatures(document, text, nested));
      continue;
    }
    const kind = first.value;
    const headerEnd = topLevelIndexOfValue(statement, ';', 1, statement.length);
    const headerLimit = headerEnd < 0 ? statement.length : headerEnd;
    const parenOpen = topLevelIndexOfValue(statement, '(', 1, headerLimit);
    const nameToken = lastIdentifierToken(statement, 1, parenOpen < 0 ? headerLimit : parenOpen);
    if (!nameToken) continue;
    const range = Range.create(document.positionAt(first.start), document.positionAt(statement[statement.length - 1].end));
    const declaration: VerilogDecl = { name: nameToken.value, kind, range, selectionRange: tokenRange(document, nameToken) };
    if (kind === 'function') {
      const returnTokens = statement.slice(1, statement.indexOf(nameToken));
      applyDeclarationWidth(declaration, firstRangeInfo(document, text, returnTokens));
      Object.assign(declaration, declarationTypeInfo(returnTokens));
      declaration.functionReturnType = declaration.valueType;
    }
    const endIndex = indexOfValueFrom(statement, kind === 'task' ? 'endtask' : 'endfunction', headerLimit);
    const body = headerEnd < 0 ? [] : statement.slice(headerEnd + 1, endIndex < 0 ? statement.length : endIndex);
    const locals = parseVerilogDeclarationTokens(document, text, body);
    const close = parenOpen < 0 ? -1 : findMatchingToken(statement, parenOpen, '(', ')');
    const ansi = close > parenOpen && parenOpen >= 0 ? parseHeaderPorts(document, text, statement.slice(parenOpen + 1, close)) : [];
    const formals = ansi.length ? ansi : locals.filter((decl) => !!decl.direction);
    for (const formal of formals) formal.storage = 'variable';
    const headerEndOffset = headerEnd < 0 ? nameToken.end : statement[headerEnd].end;
    result.push({ name: declaration.name, kind, ansi: parenOpen >= 0, declaration, formals,
      declarations: [...ansi, ...locals], range,
      headerRange: Range.create(document.positionAt(first.start), document.positionAt(headerEndOffset)),
      bodyRange: Range.create(document.positionAt(body[0]?.start ?? headerEndOffset), document.positionAt(body[body.length - 1]?.end ?? headerEndOffset))
    });
  }
  return result;
}

function inferModuleParameterConstants(module: VerilogModule): void {
  for (const decl of module.parameters) {
    const expression = decl.initializerAst ?? (decl.initializer ? parseVerilogExpression(decl.initializer) : undefined);
    const value = evalExpressionAstConstant({ kind: 'identifier', name: decl.name, start: 0, end: 0 }, module);
    if (value !== undefined) decl.constantValue = convertConstantForDecl(value, decl, module);
    const inferred = widthOfExpressionAst(expression, module);
    if (inferred.width !== undefined) {
      decl.inferredWidth = inferred.width;
      decl.inferredMinWidth = inferred.minWidth;
      decl.inferredFlexible = inferred.flexible;
    }
  }
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
  const directionToken = firstToken(cleaned, verilogPortDirections);
  const direction = directionToken?.value as 'input' | 'output' | 'inout' | undefined;
  const explicitKind = firstTokenValue(cleaned, verilogDeclarationKeywords);
  const kind = direction ?? (explicitKind ? normalizeVerilogDeclKind(explicitKind) : fallbackKind);
  const initializer = declarationInitializerInfo(document, text, cleaned);
  const unpackedDimensions = declarationDimensionInfos(document, text, cleaned, nameToken);
  const width = firstRangeInfo(document, text, cleaned);
  const inferred = (kind === 'parameter' || kind === 'localparam')
    ? initializer
    : {};
  return {
    name: nameToken.value,
    kind,
    ...declarationTypeInfo(cleaned.slice(0, cleaned.indexOf(nameToken))),
    direction,
    width: width?.width,
    widthRange: width?.widthRange,
    widthAst: width?.widthAst,
    unpackedDimensions: unpackedDimensions.length ? unpackedDimensions : undefined,
    initializer: initializer.initializer,
    initializerRange: initializer.initializerRange,
    initializerAst: initializer.initializerAst,
    inferredWidth: inferred.width,
    inferredMinWidth: inferred.minWidth,
    inferredFlexible: inferred.flexible,
    range: tokens.length ? Range.create(document.positionAt(tokens[0].start), document.positionAt(tokens[tokens.length - 1].end)) : tokenRange(document, nameToken),
    selectionRange: tokenRange(document, nameToken),
    directionRange: directionToken ? tokenRange(document, directionToken) : undefined,
    explicitPortNetType: directionToken ? hasExplicitPortNetTypeInTokens(cleaned, cleaned.indexOf(directionToken)) : undefined
  };
}

function parseInstances(
  document: TextDocument,
  text: string,
  tokens: VerilogToken[],
  currentModuleName: string,
  inGenerateBlock = false
): VerilogInstance[] {
  const instances: VerilogInstance[] = [];
  for (const statement of statementSlices(tokens)) {
    const group = parseInstanceGroup(document, text, statement, currentModuleName);
    if (group.length) {
      instances.push(...group.map((instance) => inGenerateBlock ? { ...instance, inGenerateBlock } : instance));
      continue;
    }
    // A bare generate region adds no scope; if/for/case/begin generate blocks do.
    const scoped = inGenerateBlock || statement[0]?.value !== 'generate';
    for (const nested of nestedGenerateItems(statement)) {
      instances.push(...parseInstances(document, text, nested, currentModuleName, scoped));
    }
  }
  return instances;
}

/** Explicit blocks and single generated items own independent elaboration scopes. */
function parseGenerateBlocks(
  document: TextDocument,
  text: string,
  tokens: VerilogToken[],
  branches: readonly VerilogGenerateBranch[] = [],
  constructs = { next: 0 },
  implicitBody = false
): VerilogGenerateBlock[] {
  const blocks: VerilogGenerateBlock[] = [];
  if (implicitBody && tokens.length && tokens[0].value !== 'begin') {
    blocks.push({ implicit: true, bodyTokens: tokens,
      range: tokensRange(document, tokens, tokens[0].start, tokens[tokens.length - 1].end),
      declarations: parseVerilogDeclarationTokens(document, text, tokens), branches: [...branches] });
  }
  for (const statement of generateItemSlices(tokens)) {
    const first = statement[0];
    if (first?.value === 'begin') {
      const end = findMatchingToken(statement, 0, 'begin', 'end');
      const label = statement[1]?.value === ':' && statement[2] && isIdentifierLike(statement[2].kind) ? statement[2].value : undefined;
      const body = beginBodyTokens(statement, 0);
      blocks.push({ name: label, selectionRange: label ? tokenRange(document, statement[2]) : undefined,
        range: Range.create(document.positionAt(first.start), document.positionAt(statement[end >= 0 ? end : statement.length - 1].end)),
        bodyTokens: body, declarations: parseVerilogDeclarationTokens(document, text, body), branches: [...branches] });
      blocks.push(...parseGenerateBlocks(document, text, body, branches, constructs));
      continue;
    }
    const nested = nestedGenerateItems(statement);
    if (first?.value === 'if' || first?.value === 'case' || first?.value === 'casex' || first?.value === 'casez') {
      const construct = constructs.next++;
      nested.forEach((branch, index) => blocks.push(...parseGenerateBlocks(document, text, branch, [...branches, { construct, branch: index }], constructs, true)));
    } else for (const body of nested) blocks.push(...parseGenerateBlocks(document, text, body, branches, constructs, first?.value !== 'generate'));
  }
  return blocks;
}

/** Split control bodies with the same boundary used to model generate-for ranges. */
function generateItemSlices(tokens: VerilogToken[]): VerilogToken[][] {
  const result: VerilogToken[][] = [];
  for (let cursor = 0; cursor < tokens.length;) {
    if (tokens[cursor].kind === 'eof') break;
    const close = tokens[cursor].value === 'generate' ? findMatchingToken(tokens, cursor, 'generate', 'endgenerate') : -1;
    const end = close >= cursor ? close + 1 : generateItemEnd(tokens, cursor, Infinity);
    const next = end > cursor ? end : cursor + 1;
    result.push(tokens.slice(cursor, next));
    cursor = next;
  }
  return result;
}

/** Direct bodies of generate regions, controls, branches, and explicit blocks. */
function nestedGenerateItems(statement: VerilogToken[]): VerilogToken[][] {
  const first = statement[0];
  let items: VerilogToken[][] = [];
  if (first?.value === 'generate') {
    items = [blockBodyTokens(statement, 0, 'generate', 'endgenerate')];
  } else if (first?.value === 'begin') {
    const end = findMatchingToken(statement, 0, 'begin', 'end');
    items = [beginBodyTokens(statement, 0), end >= 0 ? statement.slice(end + 1) : []];
  } else if (first?.value === 'if' || first?.value === 'for') {
    const open = indexOfValueFrom(statement, '(', 1);
    const close = open < 0 ? -1 : findMatchingToken(statement, open, '(', ')');
    if (close >= 0) {
      const end = generateItemEnd(statement, close + 1, Infinity);
      items = [statement.slice(close + 1, end)];
      if (first.value === 'if' && statement[end]?.value === 'else') items.push(statement.slice(end + 1, generateItemEnd(statement, end + 1, Infinity)));
    }
  } else if (first?.value === 'case' || first?.value === 'casex' || first?.value === 'casez') {
    const body = controlTailTokens(statement, 0);
    const content = body[body.length - 1]?.value === 'endcase' ? body.slice(0, -1) : body;
    for (let cursor = 0; cursor < content.length;) {
      const colon = topLevelIndexOfValue(content, ':', cursor, content.length);
      if (colon < 0) break;
      const end = generateItemEnd(content, colon + 1, Infinity);
      if (end <= colon + 1) break;
      items.push(content.slice(colon + 1, end));
      cursor = end;
    }
  } else if (first?.value === 'else') {
    items = [statement.slice(1)];
  }
  return items.filter((item) => item.length > 0 && item.length < statement.length);
}

function controlTailTokens(statement: VerilogToken[], keywordIndex: number): VerilogToken[] {
  const open = indexOfValueFrom(statement, '(', keywordIndex + 1);
  if (open < 0) {
    return statement.slice(keywordIndex + 1);
  }
  const close = findMatchingToken(statement, open, '(', ')');
  return close >= 0 ? statement.slice(close + 1) : statement.slice(open + 1);
}

function beginBodyTokens(statement: VerilogToken[], beginIndex: number): VerilogToken[] {
  let start = beginIndex + 1;
  if (statement[start]?.value === ':' && statement[start + 1] && isIdentifierLike(statement[start + 1].kind)) {
    start += 2;
  }
  const end = findMatchingToken(statement, beginIndex, 'begin', 'end');
  return end > start ? statement.slice(start, end) : statement.slice(start);
}

function blockBodyTokens(statement: VerilogToken[], startIndex: number, openValue: string, closeValue: string): VerilogToken[] {
  const end = findMatchingToken(statement, startIndex, openValue, closeValue);
  return end > startIndex ? statement.slice(startIndex + 1, end) : statement.slice(startIndex + 1);
}

function statementSlices(tokens: VerilogToken[]): VerilogToken[][] {
  return splitVerilogModuleItems(tokens);
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
    if (token.kind === 'keyword' && (verilogDeclarationKeywords.has(token.value) || verilogDeclarationModifiers.has(token.value))) {
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

interface DeclarationWidthInfo {
  width: string;
  widthRange: Range;
  widthAst: VerilogExpressionAst[];
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

function declarationDimensionInfos(
  document: TextDocument,
  text: string,
  tokens: VerilogToken[],
  nameToken: VerilogToken
): VerilogDeclDimension[] {
  const dimensions: VerilogDeclDimension[] = [];
  const nameIndex = tokens.indexOf(nameToken);
  if (nameIndex < 0) {
    return dimensions;
  }
  for (let index = nameIndex + 1; index < tokens.length; index++) {
    if (tokens[index].value === '=') {
      break;
    }
    if (tokens[index].value !== '[') {
      continue;
    }
    const close = findMatchingToken(tokens, index, '[', ']');
    if (close < 0) {
      continue;
    }
    const dimension = declarationWidthInfo(document, text, tokens, index, close);
    dimensions.push({
      range: dimension.widthRange,
      text: dimension.width,
      expressions: dimension.widthAst
    });
    index = close;
  }
  return dimensions;
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

function applyDeclarationWidth(decl: VerilogDecl, width: DeclarationWidthInfo | undefined): void {
  if (!width) {
    return;
  }
  decl.width = width.width;
  decl.widthRange = width.widthRange;
  decl.widthAst = width.widthAst;
}

function firstRangeInfo(document: TextDocument, text: string, tokens: VerilogToken[]): DeclarationWidthInfo | undefined {
  const nameIndex = firstDeclaratorIndex(tokens, 0);
  tokens = nameIndex >= 0 ? tokens.slice(0, nameIndex) : tokens;
  const open = tokens.findIndex((token) => token.value === '[');
  if (open < 0) {
    return undefined;
  }
  const close = findMatchingToken(tokens, open, '[', ']');
  return close >= 0 ? declarationWidthInfo(document, text, tokens, open, close) : undefined;
}

function lastRangeInfo(document: TextDocument, text: string, tokens: VerilogToken[]): DeclarationWidthInfo | undefined {
  let result: DeclarationWidthInfo | undefined;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== '[') {
      continue;
    }
    const close = findMatchingToken(tokens, index, '[', ']');
    if (close >= 0) {
      result = declarationWidthInfo(document, text, tokens, index, close);
      index = close;
    }
  }
  return result;
}

function declarationWidthInfo(
  document: TextDocument,
  text: string,
  tokens: VerilogToken[],
  open: number,
  close: number
): DeclarationWidthInfo {
  const widthTokens = tokens.slice(open, close + 1);
  const contentTokens = tokens.slice(open + 1, close);
  const widthText = text.slice(tokens[open].start, tokens[close].end);
  return {
    width: normalizeWidth(widthText) ?? widthText.trim(),
    widthRange: tokensRange(document, widthTokens, tokens[open].start, tokens[close].end),
    widthAst: parseWidthExpressionAsts(contentTokens)
  };
}

function parseWidthExpressionAsts(tokens: VerilogToken[]): VerilogExpressionAst[] {
  const separator = topLevelIndexOfValue(tokens, ':', 0, tokens.length);
  if (separator < 0) {
    const expression = parseVerilogExpressionTokens(tokens);
    return expression ? [expression] : [];
  }
  return [
    parseVerilogExpressionTokens(tokens.slice(0, separator)),
    parseVerilogExpressionTokens(tokens.slice(separator + 1))
  ].filter((expression): expression is VerilogExpressionAst => Boolean(expression));
}

function firstTokenValue(tokens: VerilogToken[], values: Set<string>): string | undefined {
  return firstToken(tokens, values)?.value;
}

function firstToken(tokens: VerilogToken[], values: Set<string>): VerilogToken | undefined {
  return tokens.find((token) => values.has(token.value));
}

function hasExplicitPortNetTypeInTokens(tokens: VerilogToken[], directionIndex: number): boolean {
  let index = directionIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value === ',' || token.value === ';' || token.value === ')') {
      return false;
    }
    if (verilogExplicitPortNetTypes.has(token.value)) {
      return true;
    }
    if (verilogDeclarationModifiers.has(token.value) || verilogPortDeclarationTypes.has(token.value)) {
      index++;
      continue;
    }
    if (token.value === '[') {
      const close = findMatchingToken(tokens, index, '[', ']');
      if (close < 0) {
        return false;
      }
      index = close + 1;
      continue;
    }
    if (token.kind === 'identifier') {
      return false;
    }
    index++;
  }
  return false;
}

function findEndmoduleToken(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === 'module') {
      return -1;
    }
    if (tokens[index].value === 'endmodule') {
      return index;
    }
  }
  return -1;
}

function findMatchingToken(tokens: VerilogToken[], openIndex: number, openValue: string, closeValue: string): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === 'module' || tokens[index].value === 'endmodule') {
      return -1;
    }
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

function isPortKind(kind: VerilogDeclKind): kind is 'input' | 'output' | 'inout' {
  return kind === 'input' || kind === 'output' || kind === 'inout';
}

/** Shared module/header/local declaration type prefix interpretation. */
function declarationTypeInfo(tokens: VerilogToken[]): Pick<VerilogDecl, 'signed' | 'valueType' | 'netType'> {
  const valueType = tokens.find((token) => ['integer', 'time', 'real', 'realtime'].includes(token.value))?.value as VerilogDecl['valueType'];
  const netType = tokens.find((token) => verilogExplicitPortNetTypes.has(token.value))?.value;
  return {
    valueType,
    netType,
    signed: tokens.some((token) => token.value === 'signed') ? true : tokens.some((token) => token.value === 'unsigned') ? false : valueType === 'integer' ? true : undefined
  };
}

function moduleHeaderListEnd(tokens: VerilogToken[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    const value = tokens[index].value;
    if (value === ';' || value === 'module' || value === 'endmodule' || tokens[index].kind === 'eof') return index;
    if (value === '(') depth++;
    if (value === ')') { depth--; if (depth === 0) return index; }
  }
  return tokens.length;
}
