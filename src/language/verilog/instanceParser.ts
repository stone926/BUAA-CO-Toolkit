import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  systemTasks,
  VerilogInstance,
  VerilogPortConnection,
  verilogKeywords
} from './model';
import {
  findMatchingParen,
  leadingWhitespaceLength,
  readIdentifier,
  skipWhitespace,
  splitTopLevelCommaSpans,
  stripCommentsAndStrings
} from './textUtils';

export function parseInstances(document: TextDocument, fullText: string, startOffset: number, endOffset: number, currentModuleName: string): VerilogInstance[] {
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
