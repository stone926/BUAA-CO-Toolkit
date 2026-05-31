import { Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { rangeKey } from '../common/util';
import {
  VerilogInclude,
  VerilogMacro,
  VerilogMacroUse
} from './model';
import { stripCommentsAndStrings } from './textUtils';

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
  while ((match = includeRegex.exec(text))) {
    const directiveEnd = match.index + match[0].indexOf(match[1]);
    if (!stripped.slice(match.index, directiveEnd).includes('`include')) {
      continue;
    }
    const pathOffset = match.index + match[0].indexOf(match[1]);
    includes.push({
      path: match[1],
      range: lineAt(document, document.positionAt(match.index).line).range,
      pathRange: Range.create(document.positionAt(pathOffset), document.positionAt(pathOffset + match[1].length))
    });
  }
  return includes;
}
