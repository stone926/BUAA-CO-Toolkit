import {
  FormattingOptions,
  Range,
  TextEdit
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CoSettings } from '../common/settings';
import { lexVerilog, VerilogToken } from './lexer';
import { topLevelAssignmentEquals } from './textUtils';

interface VerilogFormattingStyle {
  continuationIndent: number;
  spaceInRange: boolean;
  declarationRangeSpacing: 'space' | 'compact' | 'preserve';
  spaceBeforeInstancePorts: boolean;
  separateElse: boolean;
  maxBlankLines: number;
  parameterAlignment: 'none' | 'equals';
  modulePortAlignment: 'none' | 'name';
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
  blockCloseIndent?: number;
}

interface DelimiterContinuation {
  itemIndent: number;
  closeIndent: number;
}

type VerilogBlockKind = 'module' | 'begin' | 'case' | 'generate' | 'function' | 'task';

interface FormattingBlock {
  kind: VerilogBlockKind;
  closeIndent: number;
  bodyIndent: number;
}

interface CaseItemInfo {
  labelOnly: boolean;
  statement: string;
}

interface ParameterAlignmentLine {
  lineIndex: number;
  equalIndex: number;
}

interface ModulePortAlignmentLine {
  lineIndex: number;
  prefixKey: string;
  rangeIndex: number;
  rangeLength: number;
  nameIndex: number;
}

interface VerilogFormatAst {
  kind: 'document';
  nodes: VerilogFormatNode[];
}

type VerilogFormatNode = VerilogBlankNode | VerilogSyntaxLineNode;

interface VerilogBlankNode {
  kind: 'blank';
}

interface VerilogSyntaxLineNode {
  kind: 'line';
  syntax: FormattingLine;
  codeText: string;
  caseItem?: CaseItemInfo;
  openingBlock?: VerilogBlockKind;
  closingBlock?: VerilogBlockKind;
}

export function getVerilogFormattingEdits(document: TextDocument, settings: CoSettings, formatOptions: FormattingOptions): TextEdit[] {
  const style = settings.verilog.format;
  const text = document.getText();
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const newText = printVerilogFormattingAst(parseVerilogFormattingAst(text, style), style, formatOptions, eol);
  if (newText === text) {
    return [];
  }
  return [TextEdit.replace(Range.create(0, 0, document.lineCount, 0), newText)];
}

function parseVerilogFormattingAst(text: string, style: VerilogFormattingStyle): VerilogFormatAst {
  const nodes: VerilogFormatNode[] = [];
  for (const line of text.split(/\r?\n/)) {
    const logicalLines = splitLogicalFormattingLines(line, style);
    for (const logicalLine of logicalLines) {
      const trimmed = logicalLine.trim();
      if (!trimmed) {
        nodes.push({ kind: 'blank' });
        continue;
      }
      const syntax = normalizeVerilogLine(trimmed, style);
      const codeText = syntax.kind === 'code' ? splitLineComment(syntax.text).code.trim() : '';
      nodes.push({
        kind: 'line',
        syntax,
        codeText,
        caseItem: syntax.kind === 'code' ? analyzeCaseItem(codeText) : undefined,
        openingBlock: syntax.kind === 'code' ? openingBlockKind(syntax.text) : undefined,
        closingBlock: syntax.kind === 'code' ? closingBlockKind(syntax.text) : undefined
      });
    }
  }
  return {
    kind: 'document',
    nodes
  };
}

function printVerilogFormattingAst(
  ast: VerilogFormatAst,
  style: VerilogFormattingStyle,
  formatOptions: FormattingOptions,
  eol: string
): string {
  const formatted: string[] = [];
  const continuations: ContinuationContext[] = [];
  const delimiterContinuations: DelimiterContinuation[] = [];
  const blocks: FormattingBlock[] = [];
  let blankLines = 0;
  let expressionContinuationIndent: number | undefined;
  let expressionContinuationPrefix: string | undefined;
  let pendingCaseItemIndent: number | undefined;

  for (const node of ast.nodes) {
    if (node.kind === 'blank') {
      if (style.maxBlankLines > 0 && blankLines < style.maxBlankLines) {
        formatted.push('');
        blankLines++;
      }
      continue;
    }

    const normalized = node.syntax;
    blankLines = 0;
    const continuation = continuations[continuations.length - 1];
    const closesContinuation = normalized.kind === 'code' && isContinuationClose(normalized.text) && Boolean(continuation);
    let closingIndent: number | undefined;
    if (!continuation && normalized.kind === 'code') {
      const closingKind = node.closingBlock;
      if (closingKind) {
        const closed = popFormattingBlock(blocks, closingKind);
        closingIndent = closed?.closeIndent ?? Math.max(0, currentFormattingIndent(blocks) - 1);
        if (closingKind === 'case') {
          pendingCaseItemIndent = undefined;
        }
      }
    }
    const caseItem = normalized.kind === 'code' && isInsideCaseBlock(blocks)
      ? node.caseItem
      : undefined;
    const usesPendingCaseIndent = pendingCaseItemIndent !== undefined
      && normalized.kind !== 'directive'
      && !caseItem
      && closingIndent === undefined;
    const delimiterIndent = normalized.kind === 'code' && !continuation && closingIndent === undefined
      ? currentDelimiterIndent(delimiterContinuations, normalized.text)
      : undefined;

    const lineIndent = normalized.kind === 'directive'
      ? 0
      : closesContinuation && continuation
          ? continuation.closeIndent
          : continuation
            ? continuation.itemIndent
            : closingIndent ?? delimiterIndent ?? (usesPendingCaseIndent
              ? Math.max(pendingCaseItemIndent ?? 0, expressionContinuationIndent ?? currentFormattingIndent(blocks))
              : expressionContinuationIndent ?? currentFormattingIndent(blocks));
    const linePrefix = delimiterIndent === undefined && !continuation && closingIndent === undefined && !usesPendingCaseIndent && expressionContinuationPrefix
      ? expressionContinuationPrefix
      : indentText(lineIndent, formatOptions);
    formatted.push(`${linePrefix}${normalized.text}`);

    if (closesContinuation) {
      const closed = continuations.pop();
      if (closed?.moduleHeader) {
        blocks.push({
          kind: 'module',
          closeIndent: closed.blockCloseIndent ?? 0,
          bodyIndent: closed.closeIndent
        });
      }
    }

    const opened = normalized.kind === 'code' ? openedContinuation(normalized.text, lineIndent, style) : undefined;
    if (opened) {
      continuations.push(opened);
    } else if (!closesContinuation && normalized.kind === 'code') {
      const openedBlock = node.openingBlock;
      if (openedBlock) {
        blocks.push({
          kind: openedBlock,
          closeIndent: lineIndent,
          bodyIndent: lineIndent + 1
        });
      }
    }

    if (!continuation && !opened && !closesContinuation && normalized.kind === 'code') {
      updateDelimiterContinuations(delimiterContinuations, normalized.text, lineIndent, style);
    }

    if (caseItem) {
      pendingCaseItemIndent = caseItem.labelOnly ? lineIndent + 1 : undefined;
    }

    const continuationText = caseItem?.statement ?? node.codeText;
    if (normalized.kind !== 'code') {
      if (normalized.kind !== 'comment' || expressionContinuationIndent === undefined) {
        expressionContinuationIndent = undefined;
        expressionContinuationPrefix = undefined;
      }
    } else if (caseItem?.labelOnly || endsExpressionContinuation(continuationText)) {
      expressionContinuationIndent = undefined;
      expressionContinuationPrefix = undefined;
    } else if (startsExpressionContinuation(continuationText) || startsAlignedListContinuation(continuationText)) {
      expressionContinuationIndent = expressionContinuationIndent ?? lineIndent + style.continuationIndent;
      expressionContinuationPrefix = expressionContinuationPrefix
        ?? alignedContinuationPrefix(continuationText, linePrefix);
    }
  }
  return alignFormattedLines(formatted, style).join(eol);
}

function alignFormattedLines(lines: string[], style: VerilogFormattingStyle): string[] {
  let result = lines;
  if (style.parameterAlignment === 'equals') {
    result = alignParameterEquals(result);
  }
  if (style.modulePortAlignment === 'name') {
    result = alignModulePortNames(result);
  }
  return result;
}

function alignParameterEquals(lines: string[]): string[] {
  const result = [...lines];
  let index = 0;
  while (index < result.length) {
    if (!isParameterDeclarationStart(result[index])) {
      index++;
      continue;
    }
    const group: ParameterAlignmentLine[] = [];
    let cursor = index;
    while (cursor < result.length) {
      const line = result[cursor];
      const code = splitLineComment(line).code.trim();
      if (!code) {
        cursor++;
        continue;
      }
      const alignment = parameterAlignmentLine(line, cursor);
      if (!alignment) {
        break;
      }
      group.push(alignment);
      cursor++;
      if (code.endsWith(';')) {
        break;
      }
    }
    alignLineIndexes(result, group.map((item) => ({
      lineIndex: item.lineIndex,
      insertIndex: item.equalIndex
    })));
    index = Math.max(cursor, index + 1);
  }
  return result;
}

function isParameterDeclarationStart(line: string): boolean {
  return /^(?:parameter|localparam)\b/.test(splitLineComment(line).code.trim());
}

function parameterAlignmentLine(line: string, lineIndex: number): ParameterAlignmentLine | undefined {
  const code = splitLineComment(line).code;
  const equalIndex = topLevelAssignmentEquals(code);
  if (equalIndex < 0) {
    return undefined;
  }
  const left = code.slice(0, equalIndex).trim();
  if (!left || /^(?:input|output|inout|wire|reg|logic|assign|if|else|case|for|while|always)\b/.test(left)) {
    return undefined;
  }
  return { lineIndex, equalIndex };
}

function alignModulePortNames(lines: string[]): string[] {
  const result = [...lines];
  let index = 0;
  while (index < result.length) {
    if (!isModulePortListStart(result[index])) {
      index++;
      continue;
    }
    const group: ModulePortAlignmentLine[] = [];
    let cursor = index + 1;
    while (cursor < result.length) {
      const code = splitLineComment(result[cursor]).code.trim();
      if (/^\)\s*;/.test(code)) {
        break;
      }
      const alignment = modulePortAlignmentLine(result[cursor], cursor);
      if (alignment) {
        group.push(alignment);
      }
      cursor++;
    }
    alignModulePortRanges(result, group);
    const refreshed = group
      .map((item) => modulePortAlignmentLine(result[item.lineIndex], item.lineIndex))
      .filter((item): item is ModulePortAlignmentLine => Boolean(item));
    alignLineIndexes(result, refreshed.map((item) => ({
      lineIndex: item.lineIndex,
      insertIndex: item.nameIndex
    })));
    index = Math.max(cursor + 1, index + 1);
  }
  return result;
}

function isModulePortListStart(line: string): boolean {
  const code = splitLineComment(line).code.trim();
  return /^module\b[\s\S]*\($/.test(code) && !/#\s*\($/.test(code);
}

function modulePortAlignmentLine(line: string, lineIndex: number): ModulePortAlignmentLine | undefined {
  const code = splitLineComment(line).code;
  const match = /^(\s*)((?:input|output|inout)\b(?:\s+(?:wire|reg|logic|signed|unsigned|tri|tri0|tri1|supply0|supply1))*\s*)(?:(\[[^\]]+\])\s*)?([A-Za-z_]\w*)([\s\S]*)$/.exec(code);
  if (!match) {
    return undefined;
  }
  const range = match[3] ?? '';
  const rangeIndex = match[1].length + match[2].length;
  return {
    lineIndex,
    prefixKey: match[2].trim().replace(/\s+/g, ' '),
    rangeIndex,
    rangeLength: range.length,
    nameIndex: rangeIndex + range.length + (range ? 1 : 0)
  };
}

function alignModulePortRanges(lines: string[], group: ModulePortAlignmentLine[]): void {
  const byPrefix = new Map<string, ModulePortAlignmentLine[]>();
  for (const item of group) {
    const bucket = byPrefix.get(item.prefixKey) ?? [];
    bucket.push(item);
    byPrefix.set(item.prefixKey, bucket);
  }
  for (const bucket of byPrefix.values()) {
    const rangeLength = Math.max(...bucket.map((item) => item.rangeLength));
    if (rangeLength <= 0) {
      continue;
    }
    for (const item of bucket) {
      const targetNameIndex = item.rangeIndex + rangeLength + 1;
      const padding = targetNameIndex - item.nameIndex;
      if (padding <= 0) {
        continue;
      }
      const line = lines[item.lineIndex];
      lines[item.lineIndex] = `${line.slice(0, item.nameIndex)}${' '.repeat(padding)}${line.slice(item.nameIndex)}`;
    }
  }
}

function alignLineIndexes(
  lines: string[],
  targets: Array<{ lineIndex: number; insertIndex: number }>
): void {
  if (targets.length < 2) {
    return;
  }
  const targetIndex = Math.max(...targets.map((item) => item.insertIndex));
  for (const target of targets) {
    const padding = targetIndex - target.insertIndex;
    if (padding <= 0) {
      continue;
    }
    const line = lines[target.lineIndex];
    lines[target.lineIndex] = `${line.slice(0, target.insertIndex)}${' '.repeat(padding)}${line.slice(target.insertIndex)}`;
  }
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
  const comment = split.comment ? normalizeLineComment(split.comment.trim()) : '';
  if (!code) {
    return { text: comment, kind: 'comment' };
  }
  if (/^(?:\/\*|\*|\*\/)/.test(code)) {
    return {
      text: `${code}${comment ? ` ${comment}` : ''}`.trimEnd(),
      kind: 'comment'
    };
  }
  const normalizedCode = transformOutsideStrings(code, (chunk) => normalizeCodeChunk(chunk, style)).trim();
  return {
    text: `${normalizedCode}${comment ? ` ${comment}` : ''}`.trimEnd(),
    kind: isPreprocessorDirective(normalizedCode) ? 'directive' : 'code'
  };
}

function normalizeCodeChunk(chunk: string, style: VerilogFormattingStyle): string {
  let text = chunk;
  text = text.replace(/\[\s*([^\[\]:]+?)\s*:\s*([^\[\]:]+?)\s*\]/g, (_match, left: string, right: string) =>
    style.spaceInRange ? `[${left.trim()}: ${right.trim()}]` : `[${left.trim()}:${right.trim()}]`);
  text = formatDeclarationRangeSpacing(text, style);
  text = text.replace(/\balways\s*@\s*\(/g, 'always @(');
  text = text.replace(/\b(if|for|while|case|casex|casez|repeat)\s*\(/g, '$1 (');
  text = text.replace(/^module\s+([A-Za-z_]\w*)\s*\(/, 'module $1 (');
  text = text.replace(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(/, (_match, moduleName: string, instanceName: string) => {
    if (isFormattingKeyword(moduleName) || isFormattingKeyword(instanceName)) {
      return `${moduleName} ${instanceName} (`;
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
  text = text.replace(/(?<![<>=!])\s*([<>])\s*(?![<>=])/g, ' $1 ');
  text = text.replace(/(?<![<>=!])\s*=(?!=|>)\s*/g, ' = ');
  text = text.replace(/(?<=[A-Za-z0-9_$)\]}])\s*([+\-*\/%&|^])\s*(?=[A-Za-z0-9_$({\[])/g, ' $1 ');
  text = text.replace(/\)\s*begin\b/g, ') begin');
  text = formatQuestionColonSpacing(text);
  text = formatLeadingLabelSpacing(text);
  text = text.replace(/\s+;/g, ';');
  text = text.replace(/[ \t]+$/g, '');
  return text;
}

function isPreprocessorDirective(text: string): boolean {
  return /^`(?:begin_keywords|celldefine|default_nettype|define|else|elsif|end_keywords|endcelldefine|endif|ifdef|ifndef|include|line|nounconnected_drive|pragma|resetall|timescale|undef|undefineall|unconnected_drive)\b/.test(text);
}

function normalizeLineComment(comment: string): string {
  const match = /^(\/{2,})([\s\S]*)$/.exec(comment);
  if (!match) {
    return comment;
  }
  const prefix = match[1];
  const body = match[2].trim();
  if (!body) {
    return prefix;
  }
  const suffix = /^(.*?)(\/{2,})$/.exec(body);
  if (suffix && suffix[1].trim()) {
    return `${prefix} ${suffix[1].trimEnd()} ${suffix[2]}`;
  }
  return `${prefix} ${body}`;
}

function formatDeclarationRangeSpacing(text: string, style: VerilogFormattingStyle): string {
  if (style.declarationRangeSpacing === 'preserve') {
    return text;
  }
  const declarationRangeRegex = /\b((?:(?:input|output|inout)\b(?:\s+(?:wire|reg|logic|signed|unsigned|tri|tri0|tri1|supply0|supply1))*|(?:wire|reg|logic|tri|tri0|tri1|supply0|supply1)\b(?:\s+(?:signed|unsigned))*))\s*(\[[^\[\]]+\])\s*/g;
  return text.replace(declarationRangeRegex, (_match, rawPrefix: string, range: string) => {
    const prefix = rawPrefix.trim().replace(/\s+/g, ' ');
    return style.declarationRangeSpacing === 'compact'
      ? `${prefix}${range}`
      : `${prefix} ${range} `;
  });
}

function formatQuestionColonSpacing(text: string): string {
  let result = '';
  let bracket = 0;
  let ternaryDepth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '[') {
      bracket++;
      result += char;
      continue;
    }
    if (char === ']') {
      bracket = Math.max(0, bracket - 1);
      result += char;
      continue;
    }
    if (bracket === 0 && char === '?' && !isInsideBasedLiteral(text, index)) {
      result = result.replace(/[ \t]+$/g, '');
      result += ' ? ';
      ternaryDepth++;
      while (index + 1 < text.length && /[ \t]/.test(text[index + 1])) {
        index++;
      }
      continue;
    }
    if (bracket === 0 && char === ':' && ternaryDepth > 0) {
      result = result.replace(/[ \t]+$/g, '');
      result += ' : ';
      ternaryDepth--;
      while (index + 1 < text.length && /[ \t]/.test(text[index + 1])) {
        index++;
      }
      continue;
    }
    result += char;
  }
  return result;
}

function formatLeadingLabelSpacing(text: string): string {
  const colon = findLeadingLabelColon(text);
  if (colon < 0) {
    return text;
  }
  const prefix = text.slice(0, colon).trim();
  const rest = text.slice(colon + 1).trimStart();
  return rest ? `${prefix}: ${rest}` : `${prefix}:`;
}

function analyzeCaseItem(text: string): CaseItemInfo | undefined {
  const colon = findLeadingLabelColon(text);
  if (colon < 0) {
    return undefined;
  }
  const statement = text.slice(colon + 1).trim();
  return {
    labelOnly: statement.length === 0,
    statement
  };
}

function findLeadingLabelColon(text: string): number {
  let bracket = 0;
  let paren = 0;
  let brace = 0;
  let sawTopLevelQuestion = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '[') {
      bracket++;
      continue;
    }
    if (char === ']') {
      bracket = Math.max(0, bracket - 1);
      continue;
    }
    if (char === '(') {
      paren++;
      continue;
    }
    if (char === ')') {
      paren = Math.max(0, paren - 1);
      continue;
    }
    if (char === '{') {
      brace++;
      continue;
    }
    if (char === '}') {
      brace = Math.max(0, brace - 1);
      continue;
    }
    const topLevel = bracket === 0 && paren === 0 && brace === 0;
    if (!topLevel) {
      continue;
    }
    if (char === '?' && !isInsideBasedLiteral(text, index)) {
      sawTopLevelQuestion = true;
      continue;
    }
    if (char !== ':') {
      continue;
    }
    const prefix = text.slice(0, index).trim();
    if (!sawTopLevelQuestion && isCaseLabelPrefix(prefix)) {
      return index;
    }
    return -1;
  }
  return -1;
}

function isCaseLabelPrefix(prefix: string): boolean {
  if (!prefix || /^(?:if|for|while|case|casex|casez|module|assign|always|else|begin|end)\b/.test(prefix)) {
    return false;
  }
  if (/[;=<>]/.test(prefix)) {
    return false;
  }
  return /^(?:default\b|[\w$`',+\-*/%&|^~!?().{}\s]+)$/.test(prefix);
}

function isInsideBasedLiteral(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && /[A-Za-z0-9_$'?]/.test(text[start - 1])) {
    start--;
  }
  let end = index + 1;
  while (end < text.length && /[A-Za-z0-9_$'?]/.test(text[end])) {
    end++;
  }
  return /^\d*'s?[bodh][0-9a-f_xz?]+$/i.test(text.slice(start, end));
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

function currentFormattingIndent(blocks: FormattingBlock[]): number {
  return blocks[blocks.length - 1]?.bodyIndent ?? 0;
}

function currentDelimiterIndent(stack: DelimiterContinuation[], line: string): number | undefined {
  const continuation = stack[stack.length - 1];
  if (!continuation) {
    return undefined;
  }
  return startsWithDelimiterClose(line) ? continuation.closeIndent : continuation.itemIndent;
}

function startsWithDelimiterClose(line: string): boolean {
  const first = formattingTokens(line)[0]?.value;
  return first === ')' || first === ']' || first === '}';
}

function updateDelimiterContinuations(stack: DelimiterContinuation[], line: string, lineIndent: number, style: VerilogFormattingStyle): void {
  for (const token of formattingTokens(line)) {
    if (token.value === '(' || token.value === '[' || token.value === '{') {
      stack.push({
        closeIndent: lineIndent,
        itemIndent: lineIndent + style.continuationIndent
      });
      continue;
    }
    if (token.value === ')' || token.value === ']' || token.value === '}') {
      stack.pop();
    }
  }
}

function isInsideCaseBlock(blocks: FormattingBlock[]): boolean {
  return blocks.some((block) => block.kind === 'case');
}

function closingBlockKind(line: string): VerilogBlockKind | undefined {
  const first = formattingTokens(line)[0]?.value;
  if (first === 'endmodule') {
    return 'module';
  }
  if (first === 'endcase') {
    return 'case';
  }
  if (first === 'endgenerate') {
    return 'generate';
  }
  if (first === 'endfunction') {
    return 'function';
  }
  if (first === 'endtask') {
    return 'task';
  }
  if (first === 'end') {
    return 'begin';
  }
  return undefined;
}

function openingBlockKind(line: string): VerilogBlockKind | undefined {
  const tokens = formattingTokens(line);
  if (tokens[0]?.value === 'end' && tokens[1]?.value === 'else') {
    return tokens.some((token) => token.value === 'begin') ? 'begin' : undefined;
  }
  if (closingBlockKindFromTokens(tokens)) {
    return undefined;
  }
  if (tokens[0]?.value === 'module' && tokens[tokens.length - 1]?.value === ';') {
    return 'module';
  }
  if (tokens.some((token) => token.value === 'case' || token.value === 'casex' || token.value === 'casez')) {
    return 'case';
  }
  if (tokens.some((token) => token.value === 'generate')) {
    return 'generate';
  }
  if (tokens.some((token) => token.value === 'function')) {
    return 'function';
  }
  if (tokens.some((token) => token.value === 'task')) {
    return 'task';
  }
  if (tokens.some((token) => token.value === 'begin')) {
    return 'begin';
  }
  return undefined;
}

function popFormattingBlock(blocks: FormattingBlock[], kind: VerilogBlockKind): FormattingBlock | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    if (blocks[index].kind !== kind) {
      continue;
    }
    return blocks.splice(index, 1)[0];
  }
  return undefined;
}

function openedContinuation(line: string, lineIndent: number, style: VerilogFormattingStyle): ContinuationContext | undefined {
  const tokens = formattingTokens(line);
  if (tokens[tokens.length - 1]?.value !== '(') {
    return undefined;
  }
  if (!isModuleHeaderStart(tokens) && !isInstanceHeaderStart(tokens) && !(tokens[0]?.value === '#' && tokens[1]?.value === '(')) {
    return undefined;
  }
  const moduleHeader = isModuleHeaderStart(tokens);
  return {
    itemIndent: lineIndent + style.continuationIndent,
    closeIndent: lineIndent + 1,
    moduleHeader,
    blockCloseIndent: moduleHeader ? lineIndent : undefined
  };
}

function isContinuationClose(line: string): boolean {
  const tokens = formattingTokens(line);
  return tokens[0]?.value === ')' && tokens[1]?.value === ';';
}

function startsExpressionContinuation(line: string): boolean {
  const tokens = formattingTokens(line);
  const last = tokens[tokens.length - 1]?.value;
  return last === '=' || last === '?' || last === ':' || expressionContinuationOperators.has(last);
}

function startsAlignedListContinuation(line: string): boolean {
  const tokens = formattingTokens(line);
  return tokens[0]?.value === 'parameter' && tokens[tokens.length - 1]?.value === ',';
}

function alignedContinuationPrefix(line: string, linePrefix: string): string | undefined {
  const tokens = formattingTokens(line);
  if (tokens[0]?.value === 'parameter' && tokens[tokens.length - 1]?.value === ',') {
    return `${linePrefix}${' '.repeat('parameter '.length)}`;
  }
  return undefined;
}

function endsExpressionContinuation(line: string): boolean {
  const tokens = formattingTokens(line);
  return tokens[tokens.length - 1]?.value === ';';
}

function isFormattingKeyword(value: string): boolean {
  return formattingKeywords.has(value);
}

const formattingKeywords = new Set(['if', 'for', 'while', 'case', 'casex', 'casez', 'repeat', 'module', 'always', 'assign', 'else', 'begin', 'end']);
const expressionContinuationOperators = new Set([
  '||',
  '&&',
  '|',
  '&',
  '^',
  '+',
  '-',
  '*',
  '/',
  '%',
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '<<',
  '>>',
  '<<<',
  '>>>'
]);

function formattingTokens(line: string): VerilogToken[] {
  const code = splitLineComment(line).code.trim();
  if (!code) {
    return [];
  }
  return lexVerilog(code).tokens.filter((token) => token.kind !== 'eof' && token.kind !== 'comment');
}

function closingBlockKindFromTokens(tokens: VerilogToken[]): VerilogBlockKind | undefined {
  const first = tokens[0]?.value;
  if (first === 'endmodule') {
    return 'module';
  }
  if (first === 'endcase') {
    return 'case';
  }
  if (first === 'endgenerate') {
    return 'generate';
  }
  if (first === 'endfunction') {
    return 'function';
  }
  if (first === 'endtask') {
    return 'task';
  }
  return first === 'end' ? 'begin' : undefined;
}

function isModuleHeaderStart(tokens: VerilogToken[]): boolean {
  return tokens[0]?.value === 'module';
}

function isInstanceHeaderStart(tokens: VerilogToken[]): boolean {
  return tokens.length >= 3
    && tokens[0].kind === 'identifier'
    && tokens[1].kind === 'identifier'
    && tokens[tokens.length - 1]?.value === '(';
}
