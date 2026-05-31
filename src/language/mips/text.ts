import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { findCommentIndex } from './syntax';
import { escapeRegExp } from '../common/util';

export function getMipsWordRange(document: TextDocument, position: Position): Range | undefined {
  const text = lineAt(document, position.line).text;
  const regex = /[%$]?[A-Za-z_.$0-9][\w.$]*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    if (position.character >= start && position.character <= end) {
      return Range.create(position.line, start, position.line, end);
    }
  }
  return undefined;
}

export function directiveCompletionReplaceRange(linePrefix: string, position: Position): Range | undefined {
  const match = linePrefix.match(/\.[A-Za-z_]*$/);
  if (!match) {
    return undefined;
  }
  return Range.create(position.line, position.character - match[0].length, position.line, position.character);
}

export function completionReplaceRange(linePrefix: string, position: Position, pattern: RegExp): Range {
  const match = linePrefix.match(pattern);
  const length = match?.[0].length ?? 0;
  return Range.create(position.line, position.character - length, position.line, position.character);
}

export function stripLineComment(line: string): string {
  const commentIndex = findCommentIndex(line);
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

export { escapeRegExp };
