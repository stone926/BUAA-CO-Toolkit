// @index parser — 源文本→词法行→AST→语义模型→诊断
import {
  Diagnostic,
  DiagnosticSeverity,
  Position,
  Range
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { lineAt, makeDiagnostic, rangeOfText, rangesEqual } from '../common/lsp';
import { rangeKey } from '../common/util';
import { CoSettings } from '../common/settings';
import { buildMipsAst } from './ast';
import type { MipsDataDirectiveContinuationAst, MipsDirectiveAst, MipsExecutableAst, MipsOperandAst, MipsStatementAst } from './ast';
import {
  instructionWritesRegister,
  isMacroArgumentToken,
  labelOperand,
  usesMarsPseudoInstructionForm,
  validateInstruction
} from './instructionValidation';
import { isMipsStringLiteralText } from './operandAst';
import { collectMipsOperandReferences, visitMipsOperand, type MipsOperandReferenceCandidate } from './operandReferences';
import {
  directives,
  instructions,
  instructionMeta,
  isFloatingPointRegister,
  isRegister
} from './resources';
import {
  isCharLiteral,
  isFloatLiteral,
  mipsParsedRange,
  mipsParsedTokenRange,
  isSymbolLike,
  parseCharLiteral,
  parseMipsSourceDocument,
  parseIntegerLiteral
} from './syntax';
import type { MipsParsedLine, MipsParsedToken } from './syntax';
import {
  buildMipsSemanticModel,
  resolveMipsSemanticMacroParamAtPosition,
  resolveMipsSemanticSymbolAtPosition
} from './semantic';
import type {
  MipsLabelReference,
  MipsLine,
  MipsMacro,
  MipsParseOptions,
  MipsParseResult,
  MipsSymbol
} from './model';

export type {
  MipsLabelReference,
  MipsLine,
  MipsMacro,
  MipsParseOptions,
  MipsParseResult,
  MipsSymbol
} from './model';

export {
  findCommentIndex,
  formatMipsLine,
  getStringRanges,
  isInsideAnyRange,
  parseIntegerLiteral,
  parseMacroArguments,
  stripComment
} from './syntax';

type MipsSection = 'text' | 'data' | 'other';

interface MipsDirectiveOperandPart {
  text: string;
  range: Range;
}

interface MipsSymbolScope {
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  eqvSymbols: Map<string, MipsSymbol>;
}

type MipsParseCore = Omit<MipsParseResult, 'ast' | 'semantic'>;

interface PendingEmptyDataDirective {
  directive: string;
  line: number;
  range: Range;
}

// 从资源文件加载指令元数据
const STORAGE_DIRECTIVES = new Set(instructionMeta.storageDirectives);
const CONTINUABLE_DATA_DIRECTIVES = new Set(['.byte', '.half', '.word', '.float', '.double', '.ascii', '.asciiz']);
const CO_FIXED_SECTION_DIRECTIVES = new Set(instructionMeta.coFixedSectionDirectives);
const SECTION_DIRECTIVES = new Map(Object.entries(instructionMeta.sectionDirectives));
const SECTION_ADDRESS_RANGES = new Map<string, { min: number; max: number; label: string }>([
  ['.data', { min: 0x00000000, max: 0x00002fff, label: '0x00000000-0x00002fff' }],
  ['.text', { min: 0x00003000, max: 0x00006fff, label: '0x00003000-0x00006fff' }]
]);

export function parseMips(document: TextDocument, settings: CoSettings, options: MipsParseOptions = {}): MipsParseResult {
  const source = parseMipsSourceDocument(document.getText());
  const ast = buildMipsAst(document, source.lines);
  const labels = new Map<string, MipsSymbol>();
  const dataSymbols = new Map<string, MipsSymbol>();
  const eqvSymbols = new Map<string, MipsSymbol>();
  const macros = new Map<string, MipsMacro[]>();
  const instructionsSeen: MipsLine[] = [];
  const labelReferences: MipsLabelReference[] = [];
  const diagnostics: Diagnostic[] = [];
  const profile = settings.project.profile;
  const includeDiagnostics = options.includeDiagnostics !== false;
  let section: MipsSection = 'text';
  let sectionBeforeMacro: MipsSection | undefined;
  let v0BeforeMacro: boolean | undefined;
  let activeMacro: MipsMacro | undefined;
  let hasSyscall = false;
  let v0Initialized = false;
  let activeDataContinuationDirective: string | undefined;
  let pendingEmptyDataDirective: PendingEmptyDataDirective | undefined;
  const directiveContinuationLines = new Map<number, string>();

  collectMipsSourceDiagnostics(source.lines, diagnostics);

  for (const statement of ast.statements) {
    const lineNumber = statement.line;
    const executableAst = statement.executable;

    for (const label of statement.labels) {
      if (isRegister(label.name)) {
        diagnostics.push(makeDiagnostic(label.range, `寄存器 '${label.name}' 不能作为标签名`, DiagnosticSeverity.Error, 'mips-syntax-line'));
      }
      const name = label.name;
      const selectionRange = label.range;
      const symbol: MipsSymbol = {
        name,
        kind: section === 'data' ? 'data' : 'label',
        range: lineAt(document, lineNumber).range,
        selectionRange,
        macroName: activeMacro?.name
      };
      const scope = symbolScope(activeMacro, labels, dataSymbols, eqvSymbols);
      const targetMap = section === 'data' ? scope.dataSymbols : scope.labels;
      if (isReservedSymbolName(name, symbol.kind)) {
        diagnostics.push(makeDiagnostic(selectionRange, `符号 '${name}' 与保留的 MIPS 关键字冲突`, DiagnosticSeverity.Error, 'reserved-symbol'));
      }
      if (symbolScopeHas(scope, name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `重复的符号 '${name}'`, DiagnosticSeverity.Error, 'duplicate-symbol'));
      } else {
        targetMap.set(name, symbol);
      }
    }

    if (!executableAst) {
      const continuation = statement.dataContinuation;
      if (shouldTreatAsDataDirectiveContinuation(section, activeDataContinuationDirective, activeMacro, continuation)) {
        pendingEmptyDataDirective = undefined;
        validateDirectiveContinuation(document, lineNumber, activeDataContinuationDirective!, continuation, activeMacro, diagnostics);
        directiveContinuationLines.set(lineNumber, activeDataContinuationDirective!);
      } else if (pendingEmptyDataDirective && statementTerminatesDataContinuation(statement)) {
        reportMissingDataDirectiveOperands(pendingEmptyDataDirective, diagnostics);
        pendingEmptyDataDirective = undefined;
      } else if (isMalformedStatementLine(statement)) {
        diagnostics.push(makeDiagnostic(statement.dataContinuation?.range ?? statement.range, '无法解析的 MIPS 语句。请检查标签、冒号或助记符位置', DiagnosticSeverity.Error, 'mips-syntax-line'));
      }
      continue;
    }

    if (pendingEmptyDataDirective && statementTerminatesDataContinuation(statement)) {
      reportMissingDataDirectiveOperands(pendingEmptyDataDirective, diagnostics);
      pendingEmptyDataDirective = undefined;
    }

    if (executableAst.lowerMnemonic === '.eqv') {
      const eqv = executableAst.kind === 'directive' ? executableAst.eqv : undefined;
      if (eqv) {
        const name = eqv.name;
        const selectionRange = eqv.nameRange;
        const symbol: MipsSymbol = {
          name,
          kind: 'eqv',
          range: lineAt(document, lineNumber).range,
          selectionRange,
          macroName: activeMacro?.name
        };
        const scope = symbolScope(activeMacro, labels, dataSymbols, eqvSymbols);
        if (symbolScopeHas(scope, name)) {
          diagnostics.push(makeDiagnostic(selectionRange, `重复的符号 '${name}'`, DiagnosticSeverity.Error, 'duplicate-symbol'));
        } else {
          scope.eqvSymbols.set(name, symbol);
        }
      }
    }

    // 从资源文件检查段切换指令
    const targetSection = SECTION_DIRECTIVES.get(executableAst.lowerMnemonic);
    if (targetSection) {
      section = targetSection as MipsSection;
    }

    const macroStart = executableAst.kind === 'directive' && executableAst.lowerMnemonic === '.macro' ? executableAst.macroHeader : undefined;
    if (macroStart) {
      const name = macroStart.name;
      const params = macroStart.params.map((param) => param.name);
      const selectionRange = macroStart.nameRange;
      validateMacroHeader(document, lineNumber, name, params, selectionRange, diagnostics);
      const macro: MipsMacro = {
        name,
        params,
        paramSymbols: new Map(),
        labels: new Map(),
        dataSymbols: new Map(),
        eqvSymbols: new Map(),
        range: lineAt(document, lineNumber).range,
        selectionRange,
        bodyStartLine: lineNumber + 1
      };
      if (activeMacro) {
        diagnostics.push(makeDiagnostic(selectionRange, `嵌套宏 '${name}' 不受此语言服务支持`, DiagnosticSeverity.Warning, 'nested-macro'));
      }
      const overloads = macros.get(name) ?? [];
      if (overloads.some((overload) => overload.params.length === macro.params.length)) {
        diagnostics.push(makeDiagnostic(selectionRange, `重复的宏 '${name}'，具有 ${macro.params.length} 个参数`, DiagnosticSeverity.Error, 'duplicate-macro'));
      } else {
        overloads.push(macro);
        macros.set(name, overloads);
      }
      sectionBeforeMacro = section;
      section = 'text';
      v0BeforeMacro = v0Initialized;
      v0Initialized = false;
      activeMacro = macro;
      for (const param of macroStart.params) {
        if (macro.paramSymbols.has(param.name)) {
          diagnostics.push(makeDiagnostic(param.range, `重复的宏参数 '${param.name}'`, DiagnosticSeverity.Error, 'duplicate-macro-parameter'));
          continue;
        }
        macro.paramSymbols.set(param.name, {
          name: param.name,
          kind: 'macroParam',
          range: lineAt(document, lineNumber).range,
          selectionRange: param.range,
          macroName: macro.name
        });
      }
      continue;
    }

    if (executableAst.lowerMnemonic === '.end_macro') {
      if (!activeMacro) {
        diagnostics.push(makeDiagnostic(executableAst.mnemonicRange, 'Unexpected .end_macro without a matching .macro.', DiagnosticSeverity.Error, 'macro-end'));
      } else {
        activeMacro.bodyEndLine = lineNumber - 1;
        activeMacro.range = Range.create(activeMacro.range.start, lineAt(document, lineNumber).range.end);
        activeMacro = undefined;
        section = sectionBeforeMacro ?? section;
        sectionBeforeMacro = undefined;
        v0Initialized = v0BeforeMacro ?? v0Initialized;
        v0BeforeMacro = undefined;
      }
      continue;
    }

    validateRegisterOperands(statement, activeMacro, diagnostics);

    const mnemonic = executableAst.lowerMnemonic;
    if (mnemonic.startsWith('.')) {
      if (!directives.has(mnemonic)) {
        diagnostics.push(makeDiagnostic(executableAst.mnemonicRange, `未知的指令 '${executableAst.mnemonic}'`, DiagnosticSeverity.Error, 'unknown-directive'));
      }
      validateDirective(document, lineNumber, statement, section, profile, activeMacro, diagnostics);
      activeDataContinuationDirective = section === 'data' && CONTINUABLE_DATA_DIRECTIVES.has(mnemonic) && !activeMacro
        ? mnemonic
        : undefined;
      pendingEmptyDataDirective = activeDataContinuationDirective && executableAst.operands.length === 0
        ? {
          directive: mnemonic,
          line: lineNumber,
          range: executableAst.mnemonicRange
        }
        : undefined;
      continue;
    }

    const instruction = instructions[mnemonic];
    const macroOverloads = macros.get(executableAst.mnemonic);
    if (!instruction && !macroOverloads?.length) {
      const continuation = statement.dataContinuation;
      if (shouldTreatAsDataDirectiveContinuation(section, activeDataContinuationDirective, activeMacro, continuation)) {
        pendingEmptyDataDirective = undefined;
        validateDirectiveContinuation(document, lineNumber, activeDataContinuationDirective!, continuation, activeMacro, diagnostics);
        directiveContinuationLines.set(lineNumber, activeDataContinuationDirective!);
        continue;
      }
      const eqv = resolveEqvSymbolInScope(executableAst.mnemonic, activeMacro, eqvSymbols);
      if (eqv && isDeclaredBefore(eqv, Range.create(lineNumber, 0, lineNumber, 0).start)) {
        continue;
      }
      diagnostics.push(makeDiagnostic(executableAst.mnemonicRange, `未知的指令或宏 '${executableAst.mnemonic}'`, DiagnosticSeverity.Error, 'unknown-instruction'));
      continue;
    }

    activeDataContinuationDirective = undefined;

    if (section === 'data' && instruction) {
      diagnostics.push(makeDiagnostic(executableAst.mnemonicRange, `指令 '${executableAst.mnemonic}' 不能出现在数据段中。请先切换到 .text`, DiagnosticSeverity.Error, 'instruction-in-data'));
    }

    if (!instruction && macroOverloads?.length) {
      const operands = executableAst.macroArguments;
      for (const operand of operands) {
        if (!isMacroArgumentToken(operand.text)) {
          diagnostics.push(makeDiagnostic(operand.range, `宏参数 '${operand.text}' 必须是单个 MARS 语言元素；内存操作数如 4($t0) 不是有效的宏参数`, DiagnosticSeverity.Error, 'macro-argument'));
        }
      }
      if (!macroOverloads.some((macro) => macro.params.length === operands.length)) {
        const counts = [...new Set(macroOverloads.map((macro) => macro.params.length))].sort((a, b) => a - b).join('/');
        diagnostics.push(makeDiagnostic(executableAst.mnemonicRange, `宏 '${executableAst.mnemonic}' 期望 ${counts} 个参数，实际得到 ${operands.length} 个`, DiagnosticSeverity.Error, 'macro-argument-count'));
      }
    }

    if (instruction) {
      const astOperands = executableAst.operands;
      const operands = astOperands.map((operand) => operand.text);
      if (mnemonic === 'syscall') {
        hasSyscall = true;
        if (profile === 'P2' && !v0Initialized) {
          diagnostics.push(makeDiagnostic(executableAst.mnemonicRange, 'P2 syscall 以 $v0 值为调用号, 但 $v0 自上次 syscall 起未赋值', DiagnosticSeverity.Warning, 'syscall-v0-uninitialized'));
        }
      }
      const usesPseudoForm = instruction.pseudo || usesMarsPseudoInstructionForm(mnemonic, astOperands, activeMacro, eqvSymbols);
      instructionsSeen.push({
        line: lineNumber,
        mnemonic,
        operands,
        range: executableAst.mnemonicRange,
        usesPseudoForm
      });
      validateInstruction(document, lineNumber, instruction, astOperands, profile, settings, options, activeMacro, eqvSymbols, diagnostics);
      const labelRef = labelOperand(instruction, astOperands);
      if (labelRef && isSymbolLike(labelRef)) {
        labelReferences.push({
          line: lineNumber,
          operand: labelRef,
          macro: activeMacro
        });
      }
      if (mnemonic === 'syscall') {
        v0Initialized = false;
      } else if (instructionWritesRegister(mnemonic, astOperands, '$v0')) {
        v0Initialized = true;
      }
    }
  }

  if (activeMacro) {
    activeMacro.range = Range.create(activeMacro.range.start, lineAt(document, document.lineCount - 1).range.end);
    diagnostics.push(makeDiagnostic(activeMacro.selectionRange, `宏 '${activeMacro.name}' 缺少 .end_macro`, DiagnosticSeverity.Error, 'macro-unclosed'));
  }
  if (pendingEmptyDataDirective) {
    reportMissingDataDirectiveOperands(pendingEmptyDataDirective, diagnostics);
  }

  const parsed: MipsParseCore = {
    labels,
    dataSymbols,
    eqvSymbols,
    macros,
    instructions: instructionsSeen,
    diagnostics
  };
  const semantic = buildMipsSemanticModel({
    document,
    ast,
    labels,
    dataSymbols,
    eqvSymbols,
    macros,
    instructions: instructionsSeen,
    diagnostics
  });
  const parsedForQueries: MipsParseResult = {
    ...parsed,
    ast,
    semantic
  };
  const missingLabelRanges = new Set<string>();
  for (const reference of labelReferences) {
    if (!resolveReferenceSymbol(reference.operand, reference.macro, labels, dataSymbols)) {
      const range = rangeOfText(document, reference.line, reference.operand);
      missingLabelRanges.add(rangeKey(range));
      diagnostics.push(makeDiagnostic(range, `找不到标签或 data 段符号 '${reference.operand}'`, DiagnosticSeverity.Error, 'missing-label'));
    }
  }
  collectUndeclaredSymbolDiagnostics(parsedForQueries, diagnostics, missingLabelRanges, directiveContinuationLines);

  if (profile === 'P2' && settings.mips.warnMissingExitSyscall && !hasSyscall && document.lineCount > 2) {
    const firstLine = lineAt(document, 0).text;
    const range = Range.create(0, 0, 0, Math.max(1, firstLine.length));
    diagnostics.push(makeDiagnostic(range, 'P2 programs usually need a syscall exit path, otherwise MARS/online tests may time out.', DiagnosticSeverity.Warning, 'missing-syscall'));
  }

  const resultDiagnostics = includeDiagnostics ? diagnostics : [];
  return {
    ...parsed,
    ast,
    semantic: includeDiagnostics ? semantic : { ...semantic, diagnostics: resultDiagnostics },
    diagnostics: resultDiagnostics
  };
}

function collectMipsSourceDiagnostics(lines: MipsParsedLine[], diagnostics: Diagnostic[]): void {
  for (const line of lines) {
    for (const token of line.tokens) {
      if (token.kind === 'unknown') {
        diagnostics.push(malformedTokenDiagnostic(token));
      } else if (token.kind === 'string') {
        const stringDiagnostic = malformedStringTokenDiagnostic(token);
        if (stringDiagnostic) {
          diagnostics.push(stringDiagnostic);
        }
      }
    }
  }
}

function malformedTokenDiagnostic(token: MipsParsedToken): Diagnostic {
  if (token.value.startsWith('\'')) {
    const unclosed = token.value.length < 2 || !token.value.endsWith('\'');
    return makeDiagnostic(
      mipsParsedTokenRange(token),
      unclosed ? '未闭合的 MIPS 字符字面量' : '非法的 MIPS 字符字面量',
      DiagnosticSeverity.Error,
      unclosed ? 'mips-lex-unclosed-char' : 'mips-lex-char-literal'
    );
  }
  return makeDiagnostic(
    mipsParsedTokenRange(token),
    `非法的 MIPS 字符 '${token.value}'`,
    DiagnosticSeverity.Error,
    'mips-lex-unknown-token'
  );
}

function malformedStringTokenDiagnostic(token: MipsParsedToken): Diagnostic | undefined {
  if (!hasClosingMipsStringQuote(token.value)) {
    return makeDiagnostic(mipsParsedTokenRange(token), '未闭合的 MIPS 字符串字面量', DiagnosticSeverity.Error, 'mips-lex-unclosed-string');
  }
  const invalidEscape = invalidMipsStringEscapeOffset(token.value);
  if (invalidEscape === undefined) {
    return undefined;
  }
  return makeDiagnostic(
    mipsParsedRange(token.line, { start: token.start + invalidEscape, end: token.start + invalidEscape + 2 }),
    '非法的 MIPS 字符串转义序列',
    DiagnosticSeverity.Error,
    'mips-lex-string-escape'
  );
}

function hasClosingMipsStringQuote(text: string): boolean {
  if (text.length < 2 || text[0] !== '"') {
    return false;
  }
  let escaped = false;
  for (let index = 1; index < text.length; index++) {
    const char = text[index];
    if (char === '"' && !escaped) {
      return index === text.length - 1;
    }
    if (char === '\\') {
      escaped = !escaped;
    } else {
      escaped = false;
    }
  }
  return false;
}

function invalidMipsStringEscapeOffset(text: string): number | undefined {
  for (let index = 1; index < text.length - 1; index++) {
    if (text[index] !== '\\') {
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      return index;
    }
    if (isMipsSimpleEscape(next)) {
      index++;
      continue;
    }
    if (isOctalDigit(next)) {
      let cursor = index + 1;
      let digits = 0;
      while (cursor < text.length - 1 && digits < 3 && isOctalDigit(text[cursor])) {
        cursor++;
        digits++;
      }
      index = cursor - 1;
      continue;
    }
    return index;
  }
  return undefined;
}

function isMipsSimpleEscape(char: string): boolean {
  return char === '\''
    || char === '"'
    || char === '\\'
    || char === 'n'
    || char === 't'
    || char === 'b'
    || char === 'r'
    || char === 'f'
    || char === '0';
}

function statementTerminatesDataContinuation(statement: MipsStatementAst): boolean {
  if (statement.labels.length > 0) {
    return true;
  }
  const executable = statement.executable;
  if (!executable) {
    return false;
  }
  return executable.kind === 'directive' || instructions[executable.lowerMnemonic] !== undefined;
}

function isMalformedStatementLine(statement: MipsStatementAst): boolean {
  if (statement.executable) {
    return false;
  }
  if (statement.labels.length > 0 && !statement.dataContinuation) {
    return false;
  }
  return statement.text.trim().length > 0;
}

function reportMissingDataDirectiveOperands(pending: PendingEmptyDataDirective, diagnostics: Diagnostic[]): void {
  diagnostics.push(makeDiagnostic(
    pending.range,
    `${pending.directive} expects at least one operand or a continuation line before the next statement.`,
    DiagnosticSeverity.Error,
    'directive-operand-count'
  ));
}

function validateDirective(
  document: TextDocument,
  lineNumber: number,
  statement: MipsStatementAst,
  section: MipsSection,
  profile: CoSettings['project']['profile'],
  activeMacro: MipsMacro | undefined,
  diagnostics: Diagnostic[]
): void {
  const executable = statement.executable;
  if (!executable || executable.kind !== 'directive') {
    return;
  }
  const directive = executable.lowerMnemonic;
  const operandText = executable.operandText;
  const directiveRange = executable.mnemonicRange;
  if (STORAGE_DIRECTIVES.has(directive) && section !== 'data') {
    diagnostics.push(makeDiagnostic(directiveRange, `${directive} can only be used in a data segment. Switch to .data first.`, DiagnosticSeverity.Error, 'directive-segment'));
  }

  switch (directive) {
    case '.text':
    case '.data':
    case '.ktext':
    case '.kdata':
      validateDirectiveOperandCount(document, lineNumber, directive, executable.operands, 0, 1, diagnostics);
      if (executable.operands[0] && !isIntegerOrCharLiteral(executable.operands[0].text)) {
        diagnostics.push(makeDiagnostic(executable.operands[0].range, `${directive} address must be an integer literal.`, DiagnosticSeverity.Error, 'directive-operand'));
      }
      validateSectionAddressRange(directive, executable.operands[0], diagnostics);
      if (executable.operands[0] && CO_FIXED_SECTION_DIRECTIVES.has(directive) && !isAllowedCourseSectionAddress(directive, executable.operands[0], profile)) {
        diagnostics.push(makeDiagnostic(executable.operands[0].range, '课程自动测试通常不应传递自定义段地址；P7 异常处理程序仅允许 .ktext 0x4180', DiagnosticSeverity.Error, 'co-section-address'));
      }
      return;
    case '.byte':
    case '.half':
      validateStorageNumberList(document, lineNumber, directive, executable.operands, false, activeMacro, diagnostics);
      return;
    case '.word':
      validateWordDirective(document, lineNumber, executable.operands, activeMacro, diagnostics);
      return;
    case '.float':
    case '.double':
      validateFloatList(document, lineNumber, directive, executable.operands, activeMacro, diagnostics);
      return;
    case '.ascii':
    case '.asciiz':
      validateStringList(document, lineNumber, directive, executable.operands, activeMacro, diagnostics);
      return;
    case '.space':
    case '.align':
      validateSingleIntegerDirective(document, lineNumber, directive, executable.operands, activeMacro, diagnostics);
      return;
    case '.globl':
      validateLabelListDirective(document, lineNumber, directive, executable.operands, diagnostics);
      return;
    case '.extern':
      validateExternDirective(document, lineNumber, executable.operands, diagnostics);
      return;
    case '.set':
      diagnostics.push(makeDiagnostic(directiveRange, 'MARS currently ignores the .set directive.', DiagnosticSeverity.Warning, 'set-ignored'));
      return;
    case '.eqv':
      validateEqvDirective(document, lineNumber, executable, diagnostics);
      return;
    case '.macro':
      validateMacroDirectiveSyntax(document, lineNumber, executable, diagnostics);
      return;
    case '.end_macro':
      if (executable.operands.length > 0) {
        diagnostics.push(makeDiagnostic(executable.operands[0].range, '.end_macro does not accept operands.', DiagnosticSeverity.Error, 'directive-operand'));
      }
      return;
    case '.include':
      if (!validateDirectiveOperandCount(document, lineNumber, directive, executable.operands, 1, 1, diagnostics)) {
        return;
      }
      if (!isQuotedStringLiteral(executable.operands[0].text)) {
        diagnostics.push(makeDiagnostic(executable.operands[0].range, '.include expects one quoted path string.', DiagnosticSeverity.Error, 'directive-operand'));
      }
      return;
  }
}

function isAllowedCourseSectionAddress(directive: string, operand: MipsOperandAst, profile: CoSettings['project']['profile']): boolean {
  const address = parseIntegerOrCharLiteral(operand.text);
  if (directive === '.data') {
    return address === 0;
  }
  return profile === 'P7' && directive === '.ktext' && address === 0x4180;
}

function validateDirectiveContinuation(document: TextDocument, lineNumber: number, directive: string, continuation: MipsDataDirectiveContinuationAst, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  switch (directive) {
    case '.byte':
    case '.half':
      validateStorageNumberList(document, lineNumber, directive, continuation.operands, false, activeMacro, diagnostics);
      return;
    case '.word':
      validateWordDirective(document, lineNumber, continuation.operands, activeMacro, diagnostics);
      return;
    case '.float':
    case '.double':
      validateFloatList(document, lineNumber, directive, continuation.operands, activeMacro, diagnostics);
      return;
    case '.ascii':
    case '.asciiz':
      validateStringList(document, lineNumber, directive, continuation.operands, activeMacro, diagnostics);
      return;
  }
}

function shouldTreatAsDataDirectiveContinuation(
  section: MipsSection,
  directive: string | undefined,
  activeMacro: MipsMacro | undefined,
  continuation: MipsDataDirectiveContinuationAst | undefined
): continuation is MipsDataDirectiveContinuationAst {
  return section === 'data'
    && !activeMacro
    && directive !== undefined
    && CONTINUABLE_DATA_DIRECTIVES.has(directive)
    && continuation !== undefined
    && continuation.text.trim().length > 0;
}

function validateMacroHeader(document: TextDocument, lineNumber: number, name: string, params: string[], selectionRange: Range, diagnostics: Diagnostic[]): void {
  if (isReservedIdentifier(name)) {
    diagnostics.push(makeDiagnostic(selectionRange, `宏名 '${name}' 与保留的 MIPS 关键字冲突`, DiagnosticSeverity.Error, 'reserved-symbol'));
  }
  for (const param of params) {
    const paramIndex = lineAt(document, lineNumber).text.indexOf(param);
    const range = paramIndex >= 0 ? Range.create(lineNumber, paramIndex, lineNumber, paramIndex + param.length) : selectionRange;
    if (!isValidMacroParameterName(param)) {
      diagnostics.push(makeDiagnostic(range, `宏参数 '${param}' 必须以 % 或 $ 开头，并使用标识符字符`, DiagnosticSeverity.Error, 'macro-parameter'));
    }
  }
}

function validateMacroDirectiveSyntax(document: TextDocument, lineNumber: number, executable: MipsExecutableAst, diagnostics: Diagnostic[]): void {
  if (executable.kind !== 'directive' || !executable.macroHeader) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, '.macro'), '.macro expects a macro name and optional formal parameters.', DiagnosticSeverity.Error, 'macro-header'));
  }
}

function validateDirectiveOperandCount(document: TextDocument, lineNumber: number, directive: string, operands: readonly unknown[], min: number, max: number, diagnostics: Diagnostic[]): boolean {
  if (operands.length < min || operands.length > max) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, directive), `${directive} expects ${min === max ? min : `${min}-${max}`} operand(s), got ${operands.length}.`, DiagnosticSeverity.Error, 'directive-operand-count'));
    return false;
  }
  return true;
}

function validateSectionAddressRange(directive: string, operand: MipsOperandAst | undefined, diagnostics: Diagnostic[]): void {
  if (!operand) {
    return;
  }
  const expected = SECTION_ADDRESS_RANGES.get(directive);
  if (!expected) {
    return;
  }
  const address = parseIntegerOrCharLiteral(operand.text);
  if (address === undefined) {
    return;
  }
  if (address < expected.min || address > expected.max) {
    diagnostics.push(makeDiagnostic(operand.range, `${directive} 地址 ${operand.text} 超出 CompactDataAtZero 范围 ${expected.label}`, DiagnosticSeverity.Warning, 'section-address-range'));
  }
}

function validateStorageNumberList(document: TextDocument, lineNumber: number, directive: string, operands: MipsOperandAst[], allowLabels: boolean, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  if (!operands.length) {
    return;
  }
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    const { value, count } = splitRepeatOperandAst(operand);
    if (!(isIntegerOrCharLiteral(value.text) || Boolean(activeMacro?.paramSymbols.has(value.text)) || (allowLabels && isSymbolLike(value.text)))) {
      diagnostics.push(makeDiagnostic(value.range, `${directive} expects integer${allowLabels ? ' or label' : ''} operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
    if (count && !isNonNegativeIntegerOrCharLiteral(count.text)) {
      diagnostics.push(makeDiagnostic(count.range, `${directive} repeat count must be a non-negative integer.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateWordDirective(document: TextDocument, lineNumber: number, operands: MipsOperandAst[], activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  if (!operands.length) {
    return;
  }
  if (!validateDirectiveOperandCount(document, lineNumber, '.word', operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    const { value, count } = splitRepeatOperandAst(operand);
    if (!(isIntegerOrCharLiteral(value.text) || isSymbolLike(value.text) || Boolean(activeMacro?.paramSymbols.has(value.text)))) {
      diagnostics.push(makeDiagnostic(value.range, '.word expects integer or label operands.', DiagnosticSeverity.Error, 'directive-operand'));
    }
    if (count && !isNonNegativeIntegerOrCharLiteral(count.text)) {
      diagnostics.push(makeDiagnostic(count.range, '.word repeat count must be a non-negative integer.', DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateFloatList(document: TextDocument, lineNumber: number, directive: string, operands: MipsOperandAst[], activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  if (!operands.length) {
    return;
  }
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    const { value, count } = splitRepeatOperandAst(operand);
    if (!(isFloatLiteral(value.text) || isCharLiteral(value.text) || Boolean(activeMacro?.paramSymbols.has(value.text)))) {
      diagnostics.push(makeDiagnostic(value.range, `${directive} expects floating-point operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
    if (count && !isNonNegativeIntegerOrCharLiteral(count.text)) {
      diagnostics.push(makeDiagnostic(count.range, `${directive} repeat count must be a non-negative integer.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateStringList(document: TextDocument, lineNumber: number, directive: string, operands: MipsOperandAst[], activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  if (!operands.length) {
    return;
  }
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    if (!(isMipsStringLiteralText(operand.text) || Boolean(activeMacro?.paramSymbols.has(operand.text)))) {
      diagnostics.push(makeDiagnostic(operand.range, `${directive} expects string literal operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateSingleIntegerDirective(document: TextDocument, lineNumber: number, directive: string, operands: MipsOperandAst[], activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, 1, diagnostics)) {
    return;
  }
  const operand = operands[0];
  if (!(isNonNegativeIntegerOrCharLiteral(operand.text) || Boolean(activeMacro?.paramSymbols.has(operand.text)))) {
    diagnostics.push(makeDiagnostic(operand.range, `${directive} expects one non-negative integer operand.`, DiagnosticSeverity.Error, 'directive-operand'));
    return;
  }

  const value = parseIntegerOrCharLiteral(operand.text);
  if (value === undefined) {
    return;
  }
  if (directive === '.space' && value % 4 !== 0) {
    diagnostics.push(makeDiagnostic(operand.range, '.space 大小通常是 4 的倍数，以保证对齐', DiagnosticSeverity.Warning, 'space-alignment'));
  }
  if (directive === '.align' && value > 3) {
    diagnostics.push(makeDiagnostic(operand.range, `.align ${value} 表示 2^${value} 字节对齐；在该课程中很少需要`, DiagnosticSeverity.Warning, 'align-large'));
  }
}

function validateLabelListDirective(document: TextDocument, lineNumber: number, directive: string, operands: MipsOperandAst[], diagnostics: Diagnostic[]): void {
  if (!validateDirectiveOperandCount(document, lineNumber, directive, operands, 1, Number.MAX_SAFE_INTEGER, diagnostics)) {
    return;
  }
  for (const operand of operands) {
    if (!isSymbolLike(operand.text)) {
      diagnostics.push(makeDiagnostic(operand.range, `${directive} expects label operands.`, DiagnosticSeverity.Error, 'directive-operand'));
    }
  }
}

function validateExternDirective(document: TextDocument, lineNumber: number, operands: MipsOperandAst[], diagnostics: Diagnostic[]): void {
  if (!validateDirectiveOperandCount(document, lineNumber, '.extern', operands, 2, 2, diagnostics)) {
    return;
  }
  if (!isSymbolLike(operands[0].text)) {
    diagnostics.push(makeDiagnostic(operands[0].range, '.extern first operand must be a label.', DiagnosticSeverity.Error, 'directive-operand'));
  }
  if (!isNonNegativeIntegerOrCharLiteral(operands[1].text)) {
    diagnostics.push(makeDiagnostic(operands[1].range, '.extern size must be a non-negative integer.', DiagnosticSeverity.Error, 'directive-operand'));
  }
}

function validateEqvDirective(document: TextDocument, lineNumber: number, executable: MipsDirectiveAst, diagnostics: Diagnostic[]): void {
  const eqv = executable.eqv;
  if (!eqv || !eqv.replacementRange) {
    diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, '.eqv'), '.eqv expects an identifier and a replacement sequence.', DiagnosticSeverity.Error, 'directive-operand'));
    return;
  }
  if (isReservedIdentifier(eqv.name)) {
    diagnostics.push(makeDiagnostic(eqv.nameRange, `.eqv identifier '${eqv.name}' conflicts with a reserved MIPS word.`, DiagnosticSeverity.Error, 'reserved-symbol'));
  }
}

function validateRegisterOperands(statement: MipsStatementAst, activeMacro: MipsMacro | undefined, diagnostics: Diagnostic[]): void {
  for (const operand of registerOperands(statement)) {
    const reg = operand.text;
    if (activeMacro?.paramSymbols.has(reg)) {
      continue;
    }
    if (!isRegister(reg) && !isFloatingPointRegister(reg)) {
      diagnostics.push(makeDiagnostic(operand.range, `未知的寄存器 '${reg}'`, DiagnosticSeverity.Error, 'unknown-register'));
    }
  }
}

function registerOperands(statement: MipsStatementAst): MipsOperandAst[] {
  const result: MipsOperandAst[] = [];
  for (const operand of statement.executable?.operands ?? []) {
    visitMipsOperand(operand, (candidate) => {
      if (candidate.kind === 'register') {
        result.push(candidate);
      }
    });
  }
  return result;
}

function splitRepeatOperandAst(operand: MipsOperandAst): { value: MipsDirectiveOperandPart; count?: MipsDirectiveOperandPart } {
  const separator = findRepeatSeparator(operand.text);
  if (separator < 0) {
    return {
      value: operandPart(operand, 0, operand.text.length)
    };
  }
  return {
    value: operandPart(operand, 0, separator),
    count: operandPart(operand, separator + 1, operand.text.length)
  };
}

function operandPart(operand: MipsOperandAst, start: number, end: number): MipsDirectiveOperandPart {
  const text = operand.text;
  const trimmedStart = skipAsciiWhitespace(text, start);
  const trimmedEnd = trimRightIndex(text, end);
  const partStart = Math.min(trimmedStart, trimmedEnd);
  return {
    text: partStart < trimmedEnd ? text.slice(partStart, trimmedEnd) : '',
    range: Range.create(
      operand.range.start.line,
      operand.range.start.character + partStart,
      operand.range.start.line,
      operand.range.start.character + trimmedEnd
    )
  };
}

function findRepeatSeparator(text: string): number {
  let paren = 0;
  let inString = false;
  let inChar = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString || inChar) {
      if (char === '\\') {
        escaped = !escaped;
        continue;
      }
      if (!escaped && ((inString && char === '"') || (inChar && char === '\''))) {
        inString = false;
        inChar = false;
      }
      escaped = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      escaped = false;
      continue;
    }
    if (char === '\'') {
      inChar = true;
      escaped = false;
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
    if (char === ':' && paren === 0) {
      return index;
    }
  }
  return -1;
}

function isIntegerOrCharLiteral(value: string): boolean {
  return parseIntegerOrCharLiteral(value) !== undefined;
}

function isNonNegativeIntegerOrCharLiteral(value: string): boolean {
  const parsed = parseIntegerOrCharLiteral(value);
  return parsed !== undefined && parsed >= 0;
}

function parseIntegerOrCharLiteral(value: string): number | undefined {
  const charValue = parseCharLiteral(value);
  return charValue === undefined ? parseIntegerLiteral(value) : charValue;
}

function isReservedIdentifier(value: string): boolean {
  const lower = value.toLowerCase();
  return instructions[lower] !== undefined || directives.has(lower) || isRegister(value);
}

function isReservedSymbolName(value: string, kind: MipsSymbol['kind']): boolean {
  const lower = value.toLowerCase();
  if (directives.has(lower) || isRegister(value)) {
    return true;
  }
  return kind !== 'data' && instructions[lower] !== undefined;
}

function isValidMacroParameterName(value: string): boolean {
  if (!(value.startsWith('%') || value.startsWith('$')) || value.length < 2) {
    return false;
  }
  if (!isMipsSymbolStart(value[1])) {
    return false;
  }
  for (let index = 2; index < value.length; index++) {
    if (!isMipsSymbolPart(value[index])) {
      return false;
    }
  }
  return true;
}

function isQuotedStringLiteral(value: string): boolean {
  const text = value.trim();
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') {
    return false;
  }
  let escaped = false;
  for (let index = 1; index < text.length - 1; index++) {
    const char = text[index];
    if (char === '"' && !escaped) {
      return false;
    }
    if (char === '\\') {
      escaped = !escaped;
    } else {
      escaped = false;
    }
  }
  return !escaped;
}

function skipAsciiWhitespace(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && isAsciiWhitespace(text[index])) {
    index++;
  }
  return index;
}

function trimRightIndex(text: string, end: number): number {
  let index = end;
  while (index > 0 && isAsciiWhitespace(text[index - 1])) {
    index--;
  }
  return index;
}

function isMipsSymbolStart(char: string): boolean {
  return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_' || char === '.' || char === '$';
}

function isMipsSymbolPart(char: string): boolean {
  return isMipsSymbolStart(char) || (char >= '0' && char <= '9');
}

function isAsciiWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n' || char === '\f' || char === '\v';
}

function isOctalDigit(char: string): boolean {
  return char >= '0' && char <= '7';
}

function resolveEqvSymbolInScope(name: string, activeMacro: MipsMacro | undefined, eqvSymbols: Map<string, MipsSymbol>): MipsSymbol | undefined {
  return activeMacro?.eqvSymbols.get(name) ?? eqvSymbols.get(name);
}

function collectUndeclaredSymbolDiagnostics(parsed: MipsParseResult, diagnostics: Diagnostic[], skippedRanges: Set<string>, continuationDirectives: Map<number, string>): void {
  const reported = new Set<string>();
  for (const statement of parsed.ast.statements) {
    const executable = statement.executable;
    const executableRange = executable?.mnemonicRange;
    const continuationDirective = continuationDirectives.get(statement.line);
    if (continuationDirective && continuationDirective !== '.word') {
      continue;
    }
    if (shouldSkipUndeclaredCheckForDirective(executable)) {
      continue;
    }
    const continuation = continuationDirective ? statement.dataContinuation : undefined;
    const firstContinuationWordOperand = continuationDirective === '.word';
    const macroCall = macroCallAtStatement(parsed, statement);
    for (const reference of undeclaredSymbolReferences(statement, firstContinuationWordOperand, continuation)) {
      const token = reference.text;
      const range = reference.range;
      const key = rangeKey(range);
      if (
        skippedRanges.has(key) ||
        reported.has(key) ||
        isDeclarationRange(parsed, range) ||
        (executableRange && rangesEqual(executableRange, range) && !firstContinuationWordOperand)
      ) {
        continue;
      }

      if (token.startsWith('.')) {
        continue;
      }
      if (token.startsWith('$')) {
        continue;
      }
      if (instructions[token.toLowerCase()]) {
        continue;
      }
      if (parsed.semantic.macros.some((macro) => macro.name === token)) {
        continue;
      }
      if (macroCall && isMacroLabelArgument(parsed, macroCall, token)) {
        continue;
      }

      if (token.startsWith('%')) {
        if (!resolveMipsSemanticMacroParamAtPosition(parsed.semantic, token, range.start)) {
          diagnostics.push(makeDiagnostic(range, `使用未声明的宏参数 '${token}'`, DiagnosticSeverity.Error, 'undeclared-symbol'));
          reported.add(key);
        }
        continue;
      }

      const symbol = resolveMipsSemanticSymbolAtPosition(parsed.semantic, token, range.start);
      if (!symbol) {
        diagnostics.push(makeDiagnostic(range, `使用未声明的符号 '${token}'`, DiagnosticSeverity.Error, 'undeclared-symbol'));
        reported.add(key);
      } else if (symbol.kind === 'eqv' && !isDeclaredBefore(symbol, range.start)) {
        diagnostics.push(makeDiagnostic(range, `.eqv 符号 '${token}' 的使用位于声明之前. MARS .eqv 替换只发生在声明之后`, DiagnosticSeverity.Error, 'eqv-forward-reference'));
        reported.add(key);
      }
    }
  }
}

function undeclaredSymbolReferences(
  statement: MipsStatementAst,
  includeMnemonic: boolean,
  continuation?: MipsDataDirectiveContinuationAst
): MipsOperandReferenceCandidate[] {
  const references: MipsOperandReferenceCandidate[] = [];
  if (continuation) {
    for (const operand of continuation.operands) {
      references.push(...collectMipsOperandReferences(operand));
    }
    return references;
  }
  const executable = statement.executable;
  if (!executable) {
    return references;
  }
  if (includeMnemonic) {
    references.push({
      text: executable.mnemonic,
      range: executable.mnemonicRange
    });
  }
  for (const operand of executable.operands) {
    references.push(...collectMipsOperandReferences(operand));
  }
  return references;
}

function isDeclarationRange(parsed: MipsParseResult, range: Range): boolean {
  return parsed.semantic.declarationRangeKeys.has(rangeKey(range));
}

function macroCallAtStatement(parsed: MipsParseResult, statement: MipsStatementAst): { macro: MipsMacro; operands: string[] } | undefined {
  const executable = statement.executable;
  if (!executable) {
    return undefined;
  }
  const name = executable.mnemonic;
  const overloads = parsed.semantic.macros.filter((macro) => macro.name === name);
  if (!overloads.length) {
    return undefined;
  }
  const operands = executable.macroArguments.map((operand) => operand.text);
  const macro = overloads.find((candidate) => candidate.params.length === operands.length) ?? overloads[0];
  return {
    macro,
    operands
  };
}

function shouldSkipUndeclaredCheckForDirective(executable: { lowerMnemonic: string } | undefined): boolean {
  if (!executable) {
    return false;
  }
  const token = executable.lowerMnemonic;
  return token.startsWith('.') && token !== '.word';
}

function isMacroLabelArgument(parsed: MipsParseResult, call: { macro: MipsMacro; operands: string[] }, token: string): boolean {
  const labelParams = macroLabelParameters(parsed, call.macro);
  return call.operands.some((operand, index) => {
    if (operand !== token) {
      return false;
    }
    const param = call.macro.params[index];
    return param !== undefined && labelParams.has(param);
  });
}

function macroLabelParameters(parsed: MipsParseResult, macro: MipsMacro): Set<string> {
  const labelParams = new Set<string>();
  if (macro.bodyEndLine === undefined) {
    return labelParams;
  }
  for (const statement of parsed.ast.statements) {
    if (statement.line < macro.bodyStartLine || statement.line > macro.bodyEndLine) {
      continue;
    }
    for (const label of statement.labels) {
      if (macro.params.includes(label.name)) {
        labelParams.add(label.name);
      }
    }
    const executable = statement.executable;
    if (!executable) {
      continue;
    }
    const instruction = instructions[executable.lowerMnemonic];
    if (!instruction) {
      continue;
    }
    const target = labelOperand(instruction, executable.operands);
    if (target?.startsWith('%') && macro.params.includes(target)) {
      labelParams.add(target);
    }
  }
  return labelParams;
}

function isDeclaredBefore(symbol: MipsSymbol, position: Position): boolean {
  return symbol.selectionRange.start.line < position.line ||
    (symbol.selectionRange.start.line === position.line && symbol.selectionRange.start.character <= position.character);
}

function symbolScope(
  macro: MipsMacro | undefined,
  labels: Map<string, MipsSymbol>,
  dataSymbols: Map<string, MipsSymbol>,
  eqvSymbols: Map<string, MipsSymbol>
): MipsSymbolScope {
  if (macro) {
    return {
      labels: macro.labels,
      dataSymbols: macro.dataSymbols,
      eqvSymbols: macro.eqvSymbols
    };
  }
  return {
    labels,
    dataSymbols,
    eqvSymbols
  };
}

function symbolScopeHas(scope: MipsSymbolScope, name: string): boolean {
  return scope.labels.has(name) || scope.dataSymbols.has(name) || scope.eqvSymbols.has(name);
}

function resolveReferenceSymbol(
  name: string,
  macro: MipsMacro | undefined,
  labels: Map<string, MipsSymbol>,
  dataSymbols: Map<string, MipsSymbol>
): MipsSymbol | undefined {
  return macro?.labels.get(name) ?? macro?.dataSymbols.get(name) ?? labels.get(name) ?? dataSymbols.get(name);
}
