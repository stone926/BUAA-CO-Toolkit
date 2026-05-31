import {
  FoldingRange,
  FoldingRangeKind,
  Range,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  parseVerilog,
  stripCommentsAndStrings
} from './parser';

export function getVerilogFoldingRanges(document: TextDocument, settings: CoSettings): FoldingRange[] {
  const parsed = parseVerilog(document, settings, false);
  const ranges: FoldingRange[] = [];
  for (const module of parsed.modules) {
    if (module.range.end.line > module.range.start.line) {
      ranges.push({
        startLine: module.range.start.line,
        endLine: module.range.end.line,
        kind: FoldingRangeKind.Region
      });
    }
  }

  const stack: Array<{ token: string; line: number }> = [];
  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = stripCommentsAndStrings(lineAt(document, lineNumber).text);
    const trimmed = text.trim();
    if (/^\/\/\s*region\b/i.test(lineAt(document, lineNumber).text)) {
      stack.push({ token: 'region', line: lineNumber });
      continue;
    }
    if (/^\/\/\s*endregion\b/i.test(lineAt(document, lineNumber).text)) {
      closeFold(stack, ranges, 'region', lineNumber);
      continue;
    }
    const keywordRegex = /\b(begin|case|casex|casez|generate|function|task|end|endcase|endgenerate|endfunction|endtask)\b/g;
    let match: RegExpExecArray | null;
    while ((match = keywordRegex.exec(trimmed))) {
      const token = match[1];
      if (token === 'begin' || token === 'case' || token === 'casex' || token === 'casez' || token === 'generate' || token === 'function' || token === 'task') {
        stack.push({ token, line: lineNumber });
      } else {
        closeFold(stack, ranges, matchingFoldStart(token), lineNumber);
      }
    }
  }
  return ranges;
}

export function getVerilogFormattingEdits(document: TextDocument): TextEdit[] {
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const formatted: string[] = [];
  let indent = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      formatted.push('');
      continue;
    }
    if (/^(end|endcase|endgenerate|endfunction|endtask|endmodule)\b/.test(trimmed) || /^\);/.test(trimmed)) {
      indent = Math.max(0, indent - 1);
    }
    formatted.push(`${' '.repeat(indent * 4)}${trimmed}`);
    if (opensIndent(trimmed)) {
      indent++;
    }
  }
  const newText = formatted.join(eol);
  if (newText === text) {
    return [];
  }
  return [TextEdit.replace(Range.create(0, 0, document.lineCount, 0), newText)];
}

function closeFold(stack: Array<{ token: string; line: number }>, ranges: FoldingRange[], token: string, endLine: number): void {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].token !== token) {
      continue;
    }
    const start = stack.splice(index, 1)[0];
    if (endLine > start.line) {
      ranges.push({
        startLine: start.line,
        endLine,
        kind: FoldingRangeKind.Region
      });
    }
    return;
  }
}

function matchingFoldStart(token: string): string {
  switch (token) {
    case 'endcase':
      return 'case';
    case 'endgenerate':
      return 'generate';
    case 'endfunction':
      return 'function';
    case 'endtask':
      return 'task';
    default:
      return 'begin';
  }
}

function opensIndent(trimmed: string): boolean {
  if (/^(end|endcase|endgenerate|endfunction|endtask|endmodule)\b/.test(trimmed)) {
    return false;
  }
  if (/\b(begin|case|casex|casez|generate|function|task)\b/.test(trimmed)) {
    return true;
  }
  if (/^module\b/.test(trimmed) && !/\);\s*$/.test(trimmed)) {
    return true;
  }
  if (/\(\s*$/.test(trimmed)) {
    return true;
  }
  return false;
}
