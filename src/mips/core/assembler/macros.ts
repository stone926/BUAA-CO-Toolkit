// @index mips-core — 严格汇编器 .macro 定义、参数替换、标签去重与展开限额（纯 TS）

import { AssemblerDiagnostic, assemblerDiagnostic, SourceSpan } from './diagnostics';
import { ExpandedSourceLine } from './sourceGraph';
import { parseAssemblerLine, ParsedStatement, tokenizeCode } from './syntax';

export interface MacroDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: readonly ExpandedSourceLine[];
  readonly span: SourceSpan;
  readonly labels: ReadonlySet<string>;
  readonly endSpan: SourceSpan;
}

export interface MacroScanResult {
  readonly definitions: ReadonlyMap<string, MacroDefinition>;
  readonly diagnostics: readonly AssemblerDiagnostic[];
  /** Lines belonging to `.macro` bodies; the assembler pass must skip them. */
  readonly excludedLines: ReadonlySet<string>;
}

export function scanMacroDefinitions(lines: readonly ExpandedSourceLine[]): MacroScanResult {
  const definitions = new Map<string, MacroDefinition>();
  const diagnostics: AssemblerDiagnostic[] = [];
  const excludedLines = new Set<string>();
  const lineKey = (line: ExpandedSourceLine): string => `${line.sourceId}:${line.startOffset}`;
  let active:
    | {
      name: string;
      parameters: string[];
      body: ExpandedSourceLine[];
      startLine: ExpandedSourceLine;
      labels: Set<string>;
    }
    | undefined;

  const finishActive = (endLine: ExpandedSourceLine): void => {
    if (!active) return;
    if (definitions.has(active.name.toLowerCase())) {
      diagnostics.push(assemblerDiagnostic(
        'asm.symbol.duplicate',
        `重复的 macro ${active.name}`,
        { sourceId: active.startLine.sourceId, startOffset: active.startLine.startOffset, endOffset: active.startLine.endOffset }
      ));
      active = undefined;
      return;
    }
    definitions.set(active.name.toLowerCase(), {
      name: active.name,
      parameters: active.parameters,
      body: active.body,
      span: { sourceId: active.startLine.sourceId, startOffset: active.startLine.startOffset, endOffset: active.startLine.endOffset },
      labels: active.labels,
      endSpan: { sourceId: endLine.sourceId, startOffset: endLine.startOffset, endOffset: endLine.endOffset }
    });
    active = undefined;
  };

  for (const line of lines) {
    const parsed = parseAssemblerLine(line);
    if (parsed.kind !== 'statement') continue;
    const mnemonic = parsed.mnemonic?.toLowerCase();
    if (mnemonic === '.macro') {
      excludedLines.add(lineKey(line));
      if (active) {
        diagnostics.push(assemblerDiagnostic(
          'asm.syntax.macro-definition-mismatch',
          '不支持嵌套 .macro 定义',
          parsed.mnemonicSpan
        ));
        continue;
      }
      const parsedDefinition = parseMacroHeader(parsed);
      if (!parsedDefinition.ok) {
        diagnostics.push(assemblerDiagnostic('asm.syntax.macro-definition-mismatch', parsedDefinition.error ?? '非法 .macro 头', parsed.mnemonicSpan));
        continue;
      }
      if (parsedDefinition.duplicateParameter) {
        diagnostics.push(assemblerDiagnostic('asm.macro.duplicate-parameter', `macro ${parsedDefinition.name} 的形参重复`, parsed.mnemonicSpan));
        continue;
      }
      active = {
        name: parsedDefinition.name!,
        parameters: parsedDefinition.parameters!,
        body: [],
        startLine: line,
        labels: new Set()
      };
      continue;
    }
    if (mnemonic === '.end_macro') {
      excludedLines.add(lineKey(line));
      if (!active) {
        diagnostics.push(assemblerDiagnostic(
          'asm.syntax.macro-definition-mismatch',
          '.end_macro 没有匹配的 .macro',
          parsed.mnemonicSpan
        ));
        continue;
      }
      finishActive(line);
      continue;
    }
    if (active) {
      excludedLines.add(lineKey(line));
      active.body.push(line);
      for (const label of parsed.labels) active.labels.add(label.name);
    }
  }
  if (active) {
    diagnostics.push(assemblerDiagnostic(
      'asm.syntax.macro-definition-mismatch',
      `.macro ${active.name} 缺少 .end_macro`,
      { sourceId: active.startLine.sourceId, startOffset: active.startLine.startOffset, endOffset: active.startLine.endOffset }
    ));
  }
  return { definitions, diagnostics, excludedLines };
}

interface MacroHeader {
  readonly ok: boolean;
  readonly name?: string;
  readonly parameters?: string[];
  readonly duplicateParameter?: boolean;
  readonly error?: string;
}

function parseMacroHeader(statement: ParsedStatement): MacroHeader {
  if (!statement.operands.length) return { ok: false, error: '.macro 需要名称' };
  const first = statement.operands[0].text;
  const paren = first.indexOf('(');
  let name = first;
  let parameterText = '';
  if (paren >= 0) {
    if (!first.endsWith(')')) return { ok: false, error: 'macro 形参列表括号未闭合' };
    name = first.slice(0, paren).trim();
    parameterText = first.slice(paren + 1, -1).trim();
  } else if (statement.operands.length > 1) {
    parameterText = statement.operands.slice(1).map((operand) => operand.text).join(',');
  }
  if (!/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(name)) {
    return { ok: false, error: `非法的 macro 名称 ${name}` };
  }
  const parameters = parameterText
    ? parameterText.split(',').map((parameter) => normalizeParameter(parameter)).filter(Boolean)
    : [];
  for (const parameter of parameters) {
    if (!/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(parameter)) {
      return { ok: false, error: `非法的 macro 形参 ${parameter}` };
    }
  }
  return {
    ok: true,
    name,
    parameters,
    duplicateParameter: new Set(parameters).size !== parameters.length
  };
}

function normalizeParameter(parameter: string): string {
  const trimmed = parameter.trim();
  return trimmed.startsWith('%') ? trimmed.slice(1) : trimmed;
}

export interface MacroExpansionResult {
  readonly ok: boolean;
  readonly lines?: readonly ExpandedSourceLine[];
  readonly diagnostic?: AssemblerDiagnostic;
}

export function expandMacroInvocation(
  statement: ParsedStatement,
  definition: MacroDefinition,
  counter: number,
  callSpan: SourceSpan
): MacroExpansionResult {
  if (statement.operands.length !== definition.parameters.length) {
    return {
      ok: false,
      diagnostic: assemblerDiagnostic(
        'asm.macro.argument-count',
        `macro ${definition.name} 需要 ${definition.parameters.length} 个实参，实际 ${statement.operands.length}`,
        callSpan
      )
    };
  }
  const argumentsByParameter = new Map<string, string>();
  definition.parameters.forEach((parameter, index) => {
    argumentsByParameter.set(parameter, statement.operands[index].text);
  });

  const expanded: ExpandedSourceLine[] = definition.body.map((line) => {
    const text = substituteMacroTokens(line.text, definition, argumentsByParameter, counter);
    return {
      sourceId: line.sourceId,
      line: line.line,
      startOffset: line.startOffset,
      endOffset: line.endOffset,
      text,
      expansionStack: [callSpan, ...line.expansionStack]
    };
  });
  return { ok: true, lines: expanded };
}

function substituteMacroTokens(
  text: string,
  definition: MacroDefinition,
  argumentsByParameter: ReadonlyMap<string, string>,
  counter: number
): string {
  const commentIndex = findCommentIndexForMacro(text);
  const code = commentIndex >= 0 ? text.slice(0, commentIndex) : text;
  const comment = commentIndex >= 0 ? text.slice(commentIndex) : '';
  const tokens = tokenizeCode(code, '', 0);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const token of tokens) {
    if (token.kind === 'macro-parameter') {
      const parameter = token.text.slice(1);
      const value = argumentsByParameter.get(parameter);
      if (value !== undefined) {
        replacements.push({ start: token.startOffset, end: token.endOffset, value });
      }
      continue;
    }
    if (token.kind === 'identifier' && definition.labels.has(token.text)) {
      replacements.push({
        start: token.startOffset,
        end: token.endOffset,
        value: `${token.text}_M${counter}`
      });
    }
  }
  let result = code;
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index];
    result = result.slice(0, replacement.start) + replacement.value + result.slice(replacement.end);
  }
  return `${result}${comment}`;
}

function findCommentIndexForMacro(text: string): number {
  let quoted: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === quoted && !escaped) quoted = undefined;
      escaped = char === '\\' && !escaped;
      if (char !== '\\') escaped = false;
      continue;
    }
    if (char === '"' || char === "'") {
      quoted = char;
      continue;
    }
    if (char === '#') return index;
  }
  return -1;
}
