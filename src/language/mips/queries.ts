import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt, rangesEqual } from '../common/lsp';
import {
  allMacroParams,
  allMacros,
  allSymbols,
  findMacroAtPosition
} from './parser';
import { MipsMacro, MipsParseResult } from './model';
import { findCommentIndex, parseMacroArguments } from './syntax';

export function findMacroOverloadAtPosition(document: TextDocument, parsed: MipsParseResult, name: string, position: Position): MipsMacro | undefined {
  const currentMacro = findMacroAtPosition(parsed, position);
  if (currentMacro?.name === name) {
    return currentMacro;
  }

  const overloads = parsed.macros.get(name) ?? [];
  if (!overloads.length) {
    return undefined;
  }

  const callArgs = macroCallArgumentsAtPosition(document, name, position);
  if (callArgs !== undefined) {
    return overloads.find((macro) => macro.params.length === callArgs.length) ?? overloads[0];
  }

  return overloads[0];
}

export function macroCallArgumentsAtPosition(document: TextDocument, name: string, position: Position): string[] | undefined {
  const text = lineAt(document, position.line).text;
  const commentIndex = findCommentIndex(text);
  const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
  const indent = code.search(/\S/);
  if (indent < 0) {
    return undefined;
  }
  const trimmed = code.trim();
  const firstToken = trimmed.match(/^([A-Za-z_.$][\w.$]*)/);
  if (!firstToken || firstToken[1] !== name) {
    return undefined;
  }
  const tokenStart = indent + trimmed.indexOf(firstToken[1]);
  const tokenEnd = tokenStart + firstToken[1].length;
  if (position.character < tokenStart || position.character > tokenEnd) {
    return undefined;
  }
  return parseMacroArguments(trimmed.slice(firstToken[0].length).trim());
}

export function isKnownDeclarationRange(range: Range, parsed: MipsParseResult): boolean {
  const declarationRanges = [
    ...allMacros(parsed).map((macro) => macro.selectionRange),
    ...allMacroParams(parsed).map((param) => param.selectionRange),
    ...allSymbols(parsed).map((symbol) => symbol.selectionRange)
  ];
  return declarationRanges.some((declarationRange) => rangesEqual(declarationRange, range));
}
