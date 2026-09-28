// @index instance-parser — module instance groups and named/positional connection models
import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { rangeAtOffset } from '../common/lsp';
import { VerilogInstance, VerilogPortConnection } from './model';
import { isIdentifierLike, VerilogToken } from './lexer';
import { isVerilogGatePrimitive } from './gatePrimitives';
import { verilogDeclarationKeywords } from './declarations';
import { parseVerilogExpressionTokens } from './exprAst';
import { splitInstanceTokenGroup } from './instanceSyntax';
import { findMatchingTokenForward as findMatchingToken, splitTopLevelTokens } from './tokenUtils';

const excludedModuleItems = new Set([
  ...verilogDeclarationKeywords,
  'module', 'endmodule', 'assign', 'always', 'initial', 'begin', 'end',
  'if', 'else', 'case', 'casex', 'casez', 'endcase', 'for', 'forever', 'repeat', 'while',
  'task', 'endtask', 'function', 'endfunction', 'generate', 'endgenerate'
]);

export function parseInstanceGroup(document: TextDocument, text: string, statement: VerilogToken[], currentModuleName: string): VerilogInstance[] {
  const first = statement[0];
  if (!first || !isIdentifierLike(first.kind) || excludedModuleItems.has(first.value) || first.value === currentModuleName || isVerilogGatePrimitive(first.value)) {
    return [];
  }
  const group = splitInstanceTokenGroup(statement);
  if (!group) {
    return [];
  }
  const terminator = statement[statement.length - 1];
  return group.declarators.flatMap((declarator, index) => {
    if (!declarator.length) {
      return [];
    }
    const tokens = [...group.prefix, ...declarator, ...(terminator?.value === ';' ? [terminator] : [])];
    const instance = parseInstanceStatement(document, text, tokens);
    if (!instance) {
      return [];
    }
    instance.range = Range.create(
      document.positionAt(index === 0 ? statement[0].start : declarator[0].start),
      document.positionAt(index === group.declarators.length - 1 ? terminator.end : declarator[declarator.length - 1].end)
    );
    return [instance];
  });
}

function parseInstanceStatement(document: TextDocument, text: string, statement: VerilogToken[]): VerilogInstance | undefined {
  const first = statement[0];
  let index = 1;
  let parameterConnections: VerilogPortConnection[] = [];
  let parameterListRange: Range | undefined;
  if (statement[index]?.value === '#') {
    if (statement[index + 1]?.value !== '(') {
      return undefined;
    }
    const close = findMatchingToken(statement, index + 1, '(', ')');
    if (close < 0) {
      return undefined;
    }
    const content = statement.slice(index + 2, close);
    parameterConnections = parseConnectionList(document, text, content);
    parameterListRange = listRange(document, statement[index + 1], statement[close]);
    index = close + 1;
  }
  const instanceToken = statement[index];
  if (!instanceToken || !isIdentifierLike(instanceToken.kind)) {
    return undefined;
  }
  index++;
  const moduleSelectionRange = tokenRange(document, first);
  const selectionRange = tokenRange(document, instanceToken);
  if (statement[index]?.value === ';') {
    return {
      moduleName: first.value,
      instanceName: instanceToken.value,
      range: Range.create(document.positionAt(first.start), document.positionAt(statement[statement.length - 1].end)),
      moduleSelectionRange,
      selectionRange,
      parameterListRange,
      portConnections: [],
      parameterConnections
    };
  }
  if (statement[index]?.value !== '(') {
    return undefined;
  }
  const close = findMatchingToken(statement, index, '(', ')');
  if (close < 0 || (statement[close + 1] && statement[close + 1].value !== ';')) {
    return undefined;
  }
  const content = statement.slice(index + 1, close);
  return {
    moduleName: first.value,
    instanceName: instanceToken.value,
    range: Range.create(document.positionAt(first.start), document.positionAt(statement[statement.length - 1].end)),
    moduleSelectionRange,
    selectionRange,
    portListRange: content.length ? Range.create(document.positionAt(content[0].start), document.positionAt(content[content.length - 1].end)) : Range.create(document.positionAt(statement[index].end), document.positionAt(statement[index].end)),
    parameterListRange,
    portConnections: parseConnectionList(document, text, content),
    parameterConnections
  };
}

function parseConnectionList(document: TextDocument, text: string, tokens: VerilogToken[]): VerilogPortConnection[] {
  if (!tokens.length) {
    return [];
  }
  const connections: VerilogPortConnection[] = [];
  let positionalIndex = 0;
  let tokenIndex = 0;
  for (const part of splitTopLevelTokens(tokens, ',', true)) {
    const first = part[0];
    if (!first) {
      const offset = tokens[tokenIndex]?.start ?? tokens[tokens.length - 1].end;
      const range = Range.create(document.positionAt(offset), document.positionAt(offset));
      connections.push({ expression: '', expressionRange: range, range, positionalIndex });
      positionalIndex++;
      tokenIndex++;
      continue;
    }
    tokenIndex += part.length + 1;
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

function listRange(document: TextDocument, open: VerilogToken, close: VerilogToken): Range {
  return Range.create(document.positionAt(open.start + 1), document.positionAt(close.start));
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

