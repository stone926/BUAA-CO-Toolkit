import {
  FoldingRange,
  FoldingRangeKind,
  FormattingOptions,
  Range,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  stripCommentsAndStrings
} from './parser';
import { getCachedVerilogParse } from './parseCache';

export function getVerilogFoldingRanges(document: TextDocument, settings: CoSettings): FoldingRange[] {
  const parsed = getCachedVerilogParse(document, settings, false);
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

interface VerilogFormattingStyle {
  continuationIndent: number;
  spaceInRange: boolean;
  spaceBeforeInstancePorts: boolean;
  separateElse: boolean;
  maxBlankLines: number;
}

type FormattingLineKind = 'code' | 'comment' | 'directive';

interface FormattingLine {
  text: string;
  kind: FormattingLineKind;
}

interface ContinuationContext {
  itemIndent: number;
  closeIndent: number;
  moduleHeader: boolean;
}

export function getVerilogFormattingEdits(document: TextDocument, settings: CoSettings, formatOptions: FormattingOptions): TextEdit[] {
  const style = settings.verilog.format;
  const text = document.getText();
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const formatted: string[] = [];
  const continuations: ContinuationContext[] = [];
  let indent = 0;
  let blankLines = 0;
  let expressionContinuationIndent: number | undefined;

  for (const line of lines) {
    const logicalLines = splitLogicalFormattingLines(line, style);
    for (const logicalLine of logicalLines) {
      const trimmed = logicalLine.trim();
      if (!trimmed) {
        if (style.maxBlankLines > 0 && blankLines < style.maxBlankLines) {
          formatted.push('');
          blankLines++;
        }
        continue;
      }
      blankLines = 0;
      const normalized = normalizeVerilogLine(trimmed, style);
      const continuation = continuations[continuations.length - 1];
      const closesContinuation = normalized.kind === 'code' && isContinuationClose(normalized.text) && Boolean(continuation);
      if (!continuation && normalized.kind === 'code' && startsClosingBlock(normalized.text)) {
        indent = Math.max(0, indent - 1);
      }

      const lineIndent = normalized.kind === 'directive'
        ? 0
        : closesContinuation && continuation
          ? continuation.closeIndent
          : continuation
            ? continuation.itemIndent
            : expressionContinuationIndent ?? indent;
      formatted.push(`${indentText(lineIndent, formatOptions)}${normalized.text}`);

      if (closesContinuation) {
        const closed = continuations.pop();
        if (closed?.moduleHeader) {
          indent = Math.max(indent, closed.closeIndent);
        }
      }

      const opened = normalized.kind === 'code' ? openedContinuation(normalized.text, lineIndent, style) : undefined;
      if (opened) {
        continuations.push(opened);
      } else if (!closesContinuation && normalized.kind === 'code' && opensBlockIndent(normalized.text)) {
        indent++;
      }

      if (normalized.kind !== 'code' || endsExpressionContinuation(normalized.text)) {
        expressionContinuationIndent = undefined;
      } else if (startsExpressionContinuation(normalized.text)) {
        expressionContinuationIndent = lineIndent + style.continuationIndent;
      }
    }
  }

  const newText = formatted.join(eol);
  if (newText === text) {
    return [];
  }
  return [TextEdit.replace(Range.create(0, 0, document.lineCount, 0), newText)];
}

function splitLogicalFormattingLines(line: string, style: VerilogFormattingStyle): string[] {
  if (!style.separateElse) {
    return [line];
  }
  const trimmed = line.trim();
  const match = /^end\s+else\b([\s\S]*)$/.exec(trimmed);
  if (!match) {
    return [line];
  }
  return ['end', `else${match[1]}`];
}

function normalizeVerilogLine(line: string, style: VerilogFormattingStyle): FormattingLine {
  const split = splitLineComment(line);
  const code = split.code.trim();
  if (!code) {
    return { text: split.comment.trim(), kind: 'comment' };
  }
  if (/^(?:\/\*|\*|\*\/)/.test(code)) {
    return {
      text: `${code}${split.comment ? ` ${split.comment.trim()}` : ''}`.trimEnd(),
      kind: 'comment'
    };
  }
  const normalizedCode = transformOutsideStrings(code, (chunk) => normalizeCodeChunk(chunk, style)).trim();
  return {
    text: `${normalizedCode}${split.comment ? ` ${split.comment.trim()}` : ''}`.trimEnd(),
    kind: normalizedCode.startsWith('`') ? 'directive' : 'code'
  };
}

function normalizeCodeChunk(chunk: string, style: VerilogFormattingStyle): string {
  let text = chunk;
  text = text.replace(/\[\s*([^\[\]:]+?)\s*:\s*([^\[\]:]+?)\s*\]/g, (_match, left: string, right: string) =>
    style.spaceInRange ? `[${left.trim()}: ${right.trim()}]` : `[${left.trim()}:${right.trim()}]`);
  text = text.replace(/\balways\s*@\s*\(/g, 'always @(');
  text = text.replace(/\b(if|for|while|case|casex|casez|repeat)\s*\(/g, '$1 (');
  text = text.replace(/^module\s+([A-Za-z_]\w*)\s*\(/, 'module $1(');
  text = text.replace(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/, (_match, moduleName: string, instanceName: string) => {
    if (isFormattingKeyword(moduleName)) {
      return `${moduleName} ${instanceName}(`;
    }
    return style.spaceBeforeInstancePorts
      ? `${moduleName} ${instanceName} (`
      : `${moduleName} ${instanceName}(`;
  });
  text = text.replace(/\.\s*([A-Za-z_]\w*)\s*\(/g, '.$1(');
  text = text.replace(/\s+,/g, ',');
  text = text.replace(/,\s*/g, ', ');
  text = text.replace(/\(\s+/g, '(');
  text = text.replace(/\s+\)/g, ')');
  text = text.replace(/\s*(===|!==|<<<|>>>|==|!=|<=|>=|&&|\|\||<<|>>)\s*/g, ' $1 ');
  text = text.replace(/(?<![<>=!])\s*=(?!=|>)\s*/g, ' = ');
  text = text.replace(/(?<=[A-Za-z0-9_$)\]}])\s*([+\-*\/%&|^])\s*(?=[A-Za-z0-9_$({\[])/g, ' $1 ');
  text = text.replace(/\s+;/g, ';');
  text = text.replace(/[ \t]+$/g, '');
  return text;
}

function splitLineComment(line: string): { code: string; comment: string } {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length - 1; index++) {
    const char = line[index];
    if (inString) {
      escaped = char === '\\' && !escaped;
      if (char === '"' && !escaped) {
        inString = false;
      } else if (char !== '\\') {
        escaped = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '/' && line[index + 1] === '/') {
      return {
        code: line.slice(0, index),
        comment: line.slice(index)
      };
    }
  }
  return { code: line, comment: '' };
}

function transformOutsideStrings(text: string, transform: (chunk: string) => string): string {
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '"') {
      index++;
      continue;
    }
    if (start < index) {
      parts.push(transform(text.slice(start, index)));
    }
    const stringStart = index;
    index++;
    let escaped = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '"' && !escaped) {
        index++;
        break;
      }
      escaped = char === '\\' && !escaped;
      if (char !== '\\') {
        escaped = false;
      }
      index++;
    }
    parts.push(text.slice(stringStart, index));
    start = index;
  }
  if (start < text.length) {
    parts.push(transform(text.slice(start)));
  }
  return parts.join('');
}

function indentText(level: number, options: FormattingOptions): string {
  if (!options.insertSpaces) {
    return '\t'.repeat(level);
  }
  return ' '.repeat(level * options.tabSize);
}

function startsClosingBlock(line: string): boolean {
  return /^(end|endcase|endgenerate|endfunction|endtask|endmodule)\b/.test(line);
}

function opensBlockIndent(line: string): boolean {
  if (/^end\s+else\b/.test(line)) {
    return /\bbegin\b/.test(line);
  }
  if (startsClosingBlock(line)) {
    return false;
  }
  if (/\b(begin|case|casex|casez|generate|function|task)\b/.test(line)) {
    return true;
  }
  if (/^module\b/.test(line) && /;\s*$/.test(line)) {
    return true;
  }
  return false;
}

function openedContinuation(line: string, lineIndent: number, style: VerilogFormattingStyle): ContinuationContext | undefined {
  if (!/\(\s*$/.test(line)) {
    return undefined;
  }
  if (!/^module\b/.test(line) && !/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\($/.test(line) && !/^#\s*\($/.test(line)) {
    return undefined;
  }
  const moduleHeader = /^module\b/.test(line);
  return {
    itemIndent: lineIndent + style.continuationIndent,
    closeIndent: lineIndent + 1,
    moduleHeader
  };
}

function isContinuationClose(line: string): boolean {
  return /^\)\s*;/.test(line);
}

function startsExpressionContinuation(line: string): boolean {
  return !/;\s*$/.test(line) && /(?:=\s*|\?\s*|:\s*)$/.test(line);
}

function endsExpressionContinuation(line: string): boolean {
  return /;\s*$/.test(line);
}

function isFormattingKeyword(value: string): boolean {
  return /^(?:if|for|while|case|casex|casez|repeat|module|always|assign|else|begin|end)$/.test(value);
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
