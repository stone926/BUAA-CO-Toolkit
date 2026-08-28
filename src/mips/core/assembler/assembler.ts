// @index mips-core — P3–P7 课程汇编器：两遍布局、宏/include、pseudo、relocation、ProgramImage（纯 TS）

import { ProgramImage, SourceUnit, SourceUnitFingerprint, SymbolEntry } from '../api';
import { buildProgramImage } from '../programImage';
import { CourseProfile, InstructionLayer, IsaInstructionEntry, isaInstructionByMnemonic } from '../generated/isaCatalog';
import { encodeInstructionWord, EncodeOperands, InstructionEncodeError } from '../isa/encoder';
import { u32 } from '../values';
import {
  AssemblerDiagnostic,
  AssemblerDiagnosticCode,
  assemblerDiagnostic,
  SourceSpan
} from './diagnostics';
import {
  CourseSourceResolver,
  defaultAssemblerSourceLimits,
  ExpandedSourceLine,
  expandAssemblerSourceGraph,
  SourceGraphLimits
} from './sourceGraph';
import { evaluateExpression } from './expression';
import { parseIntegerLiteral, parseStringLiteralBytes } from './literals';
import { parseInstructionOperand } from './operands';
import { parseCp0Register, parseGprRegister } from './registers';
import {
  expandAluImmediatePseudo,
  expandBranchImmediatePseudo,
  expandLoadStorePseudo,
  expandPseudoInstruction,
  expandTwoOperandLogicalPseudo,
  PseudoExpansionOptions
} from './pseudo';
import {
  scanMacroDefinitions,
  expandMacroInvocation,
  MacroDefinition
} from './macros';
import {
  ParsedOperand,
  ParsedStatement,
  parseAssemblerLine
} from './syntax';
import { CourseSegmentBuilder, CourseSectionId, courseSectionLayout } from './sections';
import { WorkInstruction, WorkOperand, workOriginFor } from './work';
import type { ParsedInstructionOperand } from './operands';
import { realInstructionForms } from './instructionForms';

export const courseAssemblerSemanticsRevision = 1 as const;

export interface CourseAssemblerOptions {
  readonly profile: CourseProfile;
  readonly sourceResolver?: CourseSourceResolver;
  readonly layers?: readonly InstructionLayer[];
  readonly sourceLimits?: SourceGraphLimits;
  readonly maximumMacroDepth?: number;
  readonly maximumExpandedInstructions?: number;
  readonly maximumPseudoInstructionsPerStatement?: number;
  /** P7 generator RI victim mnemonic (`_co_internal_unknown_instruction` -> word 0x0000003f). */
  readonly p7RiInstruction?: boolean;
}

export interface CourseAssemblerResult {
  readonly ok: boolean;
  readonly image?: ProgramImage;
  readonly diagnostics: readonly AssemblerDiagnostic[];
  readonly inputGraph: readonly SourceUnitFingerprint[];
  readonly expandedInstructionCount: number;
}

const defaultLayers: readonly InstructionLayer[] = ['required', 'commonExtensions', 'marsCompatibility'];
const defaultMaximumMacroDepth = 32;
const defaultMaximumExpandedInstructions = 16_384;
const defaultMaximumPseudoPerStatement = 16;

interface LabelSymbol {
  readonly name: string;
  readonly kind: 'label';
  readonly value: number;
  readonly segment?: string;
  readonly span: SourceSpan;
}

interface EqvSymbol {
  readonly name: string;
  readonly kind: 'eqv';
  readonly expression: string;
  readonly span: SourceSpan;
}

interface InstructionPatch {
  readonly instruction: WorkInstruction;
  readonly section: 'text' | 'ktext';
  readonly wordIndex: number;
  readonly address: number;
}

interface DataPatch {
  readonly address: number;
  readonly width: 1 | 2 | 4 | 8;
  readonly expression: string;
  readonly span: SourceSpan;
  readonly origin: WorkInstruction['origin'];
  readonly float?: boolean;
}

interface MacroFrame {
  readonly definition: MacroDefinition;
  readonly callSpan: SourceSpan;
  readonly name: string;
}

interface NormalizedAssemblerOptions {
  readonly profile: CourseProfile;
  readonly layers: readonly InstructionLayer[];
  readonly sourceResolver?: CourseSourceResolver;
  readonly sourceLimits: SourceGraphLimits;
  readonly maximumMacroDepth: number;
  readonly maximumExpandedInstructions: number;
  readonly maximumPseudoInstructionsPerStatement: number;
  readonly p7RiInstruction: boolean;
}

interface AssemblyState {
  readonly profile: CourseProfile;
  readonly layers: readonly InstructionLayer[];
  readonly options: NormalizedAssemblerOptions;
  readonly builder: CourseSegmentBuilder;
  readonly labels: Map<string, LabelSymbol>;
  readonly eqvs: Map<string, EqvSymbol>;
  readonly macros: ReadonlyMap<string, MacroDefinition>;
  readonly diagnostics: AssemblerDiagnostic[];
  readonly instructionPatches: InstructionPatch[];
  readonly dataPatches: DataPatch[];
  currentSection: CourseSectionId;
  expandedInstructionCount: number;
  macroCounter: number;
  externAddress: number;
}

/** Compatibility aliases for callers that name the pure assembler entry point. */
export const assembleProgram = assembleCourseSource;
export const assembleCourseProgram = assembleCourseSource;

export function assembleCourseSource(
  root: SourceUnit,
  options: CourseAssemblerOptions
): CourseAssemblerResult {
  const profile = options.profile;
  const layers = options.layers ?? defaultLayers;
  const expandedGraph = expandAssemblerSourceGraph(
    root,
    options.sourceResolver,
    options.sourceLimits ?? defaultAssemblerSourceLimits
  );
  const macroScan = scanMacroDefinitions(expandedGraph.lines);
  const diagnostics: AssemblerDiagnostic[] = [
    ...expandedGraph.diagnostics,
    ...macroScan.diagnostics
  ];
  if (diagnostics.length) {
    return {
      ok: false,
      diagnostics,
      inputGraph: expandedGraph.inputGraph,
      expandedInstructionCount: 0
    };
  }

  const state: AssemblyState = {
    profile,
    layers,
    options: {
      profile,
      layers,
      sourceResolver: options.sourceResolver,
      sourceLimits: options.sourceLimits ?? defaultAssemblerSourceLimits,
      maximumMacroDepth: options.maximumMacroDepth ?? defaultMaximumMacroDepth,
      maximumExpandedInstructions: options.maximumExpandedInstructions ?? defaultMaximumExpandedInstructions,
      maximumPseudoInstructionsPerStatement: options.maximumPseudoInstructionsPerStatement ?? defaultMaximumPseudoPerStatement,
      p7RiInstruction: options.p7RiInstruction ?? false
    },
    builder: new CourseSegmentBuilder(),
    labels: new Map(),
    eqvs: new Map(),
    macros: macroScan.definitions,
    diagnostics: [],
    instructionPatches: [],
    dataPatches: [],
    currentSection: 'text',
    expandedInstructionCount: 0,
    macroCounter: 0,
    externAddress: 0x1000
  };

  const queue: Array<{ line: ExpandedSourceLine; macroStack: readonly MacroFrame[] }> = [];
  for (const line of expandedGraph.lines) {
    if (macroScan.excludedLines.has(`${line.sourceId}:${line.startOffset}`)) continue;
    queue.push({ line, macroStack: [] });
  }

  // Pass 1: layout. The queue grows in place when macro invocations expand.
  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    const parsed = parseAssemblerLine(item.line);
    if (parsed.kind !== 'statement') continue;
    defineLabels(parsed, state);
    const mnemonic = parsed.mnemonic?.toLowerCase() ?? '';
    if (!mnemonic) continue;

    if (!mnemonic.startsWith('.') && state.macros.has(mnemonic)) {
      const definition = state.macros.get(mnemonic)!;
      if (item.macroStack.some((frame) => frame.name === mnemonic)) {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.macro.recursion-limit',
          `macro ${mnemonic} 递归展开超过活动栈限制`,
          parsed.mnemonicSpan,
          parsed.expansionStack
        ));
        continue;
      }
      if (item.macroStack.length >= state.options.maximumMacroDepth) {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.macro.recursion-limit',
          `macro 展开深度超过上限 ${state.options.maximumMacroDepth}`,
          parsed.mnemonicSpan,
          parsed.expansionStack
        ));
        continue;
      }
      const callSpan = statementSpan(parsed);
      const expansion = expandMacroInvocation(parsed, definition, ++state.macroCounter, callSpan);
      if (!expansion.ok) {
        state.diagnostics.push(expansion.diagnostic!);
        continue;
      }
      const expandedItems = expansion.lines!.map((line) => ({
        line,
        macroStack: [...item.macroStack, { definition, callSpan, name: mnemonic } satisfies MacroFrame]
      }));
      queue.splice(index + 1, 0, ...expandedItems);
      continue;
    }

    if (mnemonic.startsWith('.')) {
      processDirective(parsed, mnemonic, state);
      continue;
    }

    const work = statementWork(parsed, state);
    if (!work.ok) {
      state.diagnostics.push(work.diagnostic!);
      continue;
    }
    if (state.currentSection === 'data') {
      state.diagnostics.push(assemblerDiagnostic(
        'asm.syntax.directive-in-data',
        `指令 ${mnemonic} 不能出现在 data 段`,
        parsed.mnemonicSpan,
        parsed.expansionStack
      ));
      continue;
    }
    for (const instruction of work.instructions!) {
      if (state.expandedInstructionCount >= state.options.maximumExpandedInstructions) {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.macro.expansion-limit',
          `展开后指令数超过上限 ${state.options.maximumExpandedInstructions}`,
          instruction.origin.span,
          instruction.origin.expansionStack
        ));
        break;
      }
      state.expandedInstructionCount++;
      const section = state.currentSection === 'ktext' ? 'ktext' : 'text';
      const patch = layoutInstruction(instruction, section, state);
      if (patch.diagnostic) state.diagnostics.push(patch.diagnostic);
    }
  }

  if (state.diagnostics.length) {
    return {
      ok: false,
      diagnostics: [...diagnostics, ...state.diagnostics],
      inputGraph: expandedGraph.inputGraph,
      expandedInstructionCount: state.expandedInstructionCount
    };
  }

  // Pass 2: encode every instruction and patch every data relocation.
  const segmentsBeforePatch = state.builder.toSegments();
  const segmentIndexByName = new Map(segmentsBeforePatch.map((segment, index) => [segment.name, index]));
  for (const patch of state.instructionPatches) {
    const segment = segmentsBeforePatch[segmentIndexByName.get(patch.section)!];
    const encoded = encodeWorkInstruction(patch.instruction, patch.address, state);
    if (encoded.diagnostic) {
      state.diagnostics.push(encoded.diagnostic);
      continue;
    }
    (segment.words as number[])[patch.wordIndex] = encoded.word!;
  }
  for (const patch of state.dataPatches) {
    const encoded = encodeDataPatch(patch, state);
    if (encoded.diagnostic) {
      state.diagnostics.push(encoded.diagnostic);
      continue;
    }
    state.builder.writeDataBytesAt(patch.address, encoded.bytes!, patch.origin);
  }

  if (state.diagnostics.length) {
    return {
      ok: false,
      diagnostics: [...diagnostics, ...state.diagnostics],
      inputGraph: expandedGraph.inputGraph,
      expandedInstructionCount: state.expandedInstructionCount
    };
  }

  const symbols: SymbolEntry[] = [];
  for (const symbol of [...state.labels.values(), ...state.eqvs.values()]) {
    if (symbol.kind === 'label') {
      symbols.push({
        name: symbol.name,
        ...(symbol.segment ? { segment: symbol.segment } : {}),
        kind: symbol.kind,
        value: symbol.value
      });
      continue;
    }
    try {
      symbols.push({
        name: symbol.name,
        kind: symbol.kind,
        value: resolveEqv(symbol.name, state)
      });
    } catch (error) {
      state.diagnostics.push(assemblerDiagnostic(
        'asm.symbol.eqv-cycle',
        error instanceof Error ? error.message : String(error),
        symbol.span,
        undefined
      ));
    }
  }
  if (state.diagnostics.length) {
    return {
      ok: false,
      diagnostics: [...diagnostics, ...state.diagnostics],
      inputGraph: expandedGraph.inputGraph,
      expandedInstructionCount: state.expandedInstructionCount
    };
  }
  const image = buildProgramImage({
    entryPc: courseSectionLayout.text.base,
    segments: state.builder.toSegments(),
    symbols,
    sourceMap: state.builder.toSourceMap(),
    inputGraph: expandedGraph.inputGraph
  });
  return {
    ok: true,
    image,
    diagnostics,
    inputGraph: expandedGraph.inputGraph,
    expandedInstructionCount: state.expandedInstructionCount
  };
}

// ── pass 1: directives ───────────────────────────────────────────────────────

function fixDataLabelsFrom(state: AssemblyState, oldAddress: number, newAddress: number): void {
  if (oldAddress === newAddress) return;
  for (const [name, symbol] of state.labels) {
    if (symbol.kind === 'label' && symbol.segment === 'data' && symbol.value === oldAddress) {
      state.labels.set(name, { ...symbol, value: newAddress });
    }
  }
}

function defineLabels(statement: ParsedStatement, state: AssemblyState): void {
  for (const label of statement.labels) {
    const name = label.name;
    if (parseGprRegister(name) !== undefined || parseCp0Register(name) !== undefined) {
      state.diagnostics.push(assemblerDiagnostic(
        'asm.syntax.invalid-label',
        `寄存器名不能作为标签：${name}`,
        label.nameSpan,
        statement.expansionStack
      ));
      continue;
    }
    const existing = state.labels.get(name) ?? state.eqvs.get(name);
    if (existing) {
      state.diagnostics.push(assemblerDiagnostic(
        'asm.symbol.duplicate',
        `重复的符号 ${name}`,
        label.nameSpan,
        statement.expansionStack
      ));
      continue;
    }
    const segment = state.currentSection === 'data' ? 'data'
      : state.currentSection === 'ktext' ? 'ktext' : 'text';
    state.labels.set(name, {
      name,
      kind: 'label',
      value: state.builder.cursor(state.currentSection),
      segment,
      span: label.nameSpan
    });
  }
}

function processDirective(statement: ParsedStatement, mnemonic: string, state: AssemblyState): void {
  const span = statementSpan(statement);
  const operands = statement.operands;
  switch (mnemonic) {
    case '.text':
    case '.ktext':
      state.currentSection = mnemonic === '.text' ? 'text' : 'ktext';
      if (operands.length === 1) {
        const address = requiredInteger(operands[0], state, 0, 0xffff_ffff);
        if (address.ok) setSectionCursor(state, state.currentSection, address.value, span, statement.expansionStack);
        else invalidDirectiveInteger(statement, operands[0], state, `${mnemonic} 地址`);
      } else if (operands.length > 1) {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.operand.wrong-count',
          `${mnemonic} 最多接受一个地址操作数`,
          span,
          statement.expansionStack
        ));
      }
      break;
    case '.data':
      state.currentSection = 'data';
      state.builder.resetAutoAlign();
      if (operands.length === 1) {
        const address = requiredInteger(operands[0], state, 0, 0xffff_ffff);
        if (address.ok) setSectionCursor(state, 'data', address.value, span, statement.expansionStack);
        else invalidDirectiveInteger(statement, operands[0], state, '.data 地址');
      } else if (operands.length > 1) {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.operand.wrong-count',
          '.data 最多接受一个地址操作数',
          span,
          statement.expansionStack
        ));
      }
      break;
    case '.kdata':
      state.diagnostics.push(assemblerDiagnostic(
        'asm.syntax.unknown-directive',
        '.kdata 不在课程汇编器声明支持范围内',
        statement.mnemonicSpan,
        statement.expansionStack
      ));
      break;
    case '.align':
      if (state.currentSection !== 'data') {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.syntax.directive-in-text',
          '.align 只能出现在 data 段',
          statement.mnemonicSpan,
          statement.expansionStack
        ));
        break;
      }
      if (operands.length !== 1) {
        state.diagnostics.push(assemblerDiagnostic('asm.operand.wrong-count', '.align 需要一个整数操作数', span, statement.expansionStack));
        break;
      }
      {
        const exponent = requiredInteger(operands[0], state, 0, 16);
        if (!exponent.ok) {
          invalidDirectiveInteger(statement, operands[0], state, '.align 指数');
          break;
        }
        try {
          const oldAddress = state.builder.cursor('data');
          state.builder.alignData(exponent.value);
          fixDataLabelsFrom(state, oldAddress, state.builder.cursor('data'));
        } catch (error) {
          state.diagnostics.push(diagnosticForError('asm.section.outside-course-address-space', error, span, statement.expansionStack));
        }
      }
      break;
    case '.space':
      if (state.currentSection !== 'data') {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.syntax.directive-in-text',
          '.space 只能出现在 data 段',
          statement.mnemonicSpan,
          statement.expansionStack
        ));
        break;
      }
      if (operands.length !== 1) {
        state.diagnostics.push(assemblerDiagnostic('asm.operand.wrong-count', '.space 需要一个整数操作数', span, statement.expansionStack));
        break;
      }
      {
        const bytes = requiredInteger(operands[0], state, 0, courseSectionLayout.data.endInclusive + 1);
        if (!bytes.ok) {
          invalidDirectiveInteger(statement, operands[0], state, '.space 字节数');
          break;
        }
        try {
          state.builder.appendDataSpace(bytes.value);
        } catch (error) {
          state.diagnostics.push(diagnosticForError('asm.section.outside-course-address-space', error, span, statement.expansionStack));
        }
      }
      break;
    case '.word':
    case '.half':
    case '.byte':
      if (state.currentSection !== 'data') {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.syntax.directive-in-text',
          `${mnemonic} 只能出现在 data 段`,
          statement.mnemonicSpan,
          statement.expansionStack
        ));
        break;
      }
      processNumericDataDirective(statement, mnemonic, state);
      break;
    case '.float':
    case '.double':
      if (state.currentSection !== 'data') {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.syntax.directive-in-text',
          `${mnemonic} 只能出现在 data 段`,
          statement.mnemonicSpan,
          statement.expansionStack
        ));
        break;
      }
      processFloatDataDirective(statement, mnemonic, state);
      break;
    case '.ascii':
    case '.asciiz':
      if (state.currentSection !== 'data') {
        state.diagnostics.push(assemblerDiagnostic(
          'asm.syntax.directive-in-text',
          `${mnemonic} 只能出现在 data 段`,
          statement.mnemonicSpan,
          statement.expansionStack
        ));
        break;
      }
      processStringDataDirective(statement, mnemonic, state);
      break;
    case '.globl':
      if (operands.length !== 1) {
        state.diagnostics.push(assemblerDiagnostic('asm.operand.wrong-count', '.globl 需要一个符号名', span, statement.expansionStack));
      }
      break;
    case '.eqv':
      processEqv(statement, state);
      break;
    case '.extern':
      processExtern(statement, state);
      break;
    case '.set':
      // Accepted for MARS source compatibility; does not change the course image.
      break;
    default:
      state.diagnostics.push(assemblerDiagnostic(
        'asm.syntax.unknown-directive',
        `未知或不支持的 directive ${statement.mnemonic}`,
        statement.mnemonicSpan,
        statement.expansionStack
      ));
      break;
  }
}

function processExtern(statement: ParsedStatement, state: AssemblyState): void {
  if (statement.operands.length !== 2) {
    state.diagnostics.push(assemblerDiagnostic('asm.operand.wrong-count', '.extern 需要符号名和字节大小', statementSpan(statement), statement.expansionStack));
    return;
  }
  const name = statement.operands[0].text.trim();
  const size = requiredInteger(statement.operands[1], state, 0, 0x0010_0000);
  if (!size.ok) {
    invalidDirectiveInteger(statement, statement.operands[1], state, '.extern 大小');
    return;
  }
  if (state.labels.has(name) || state.eqvs.has(name)) {
    state.diagnostics.push(assemblerDiagnostic('asm.symbol.duplicate', `重复的符号 ${name}`, statement.operands[0].span, statement.expansionStack));
    return;
  }
  state.labels.set(name, {
    name,
    kind: 'label',
    value: state.externAddress,
    span: statement.operands[0].span
  });
  state.externAddress = (state.externAddress + size.value) >>> 0;
}

function invalidDirectiveInteger(
  statement: ParsedStatement,
  operand: ParsedOperand,
  state: AssemblyState,
  label: string
): void {
  state.diagnostics.push(assemblerDiagnostic(
    'asm.operand.invalid-immediate',
    `${label}必须是范围内的整数：${operand.text}`,
    operand.span,
    statement.expansionStack
  ));
}

function processEqv(statement: ParsedStatement, state: AssemblyState): void {
  let name = '';
  let expression = '';
  let expressionSpan = statementSpan(statement);
  if (statement.operands.length >= 2) {
    name = statement.operands[0].text.trim();
    expression = statement.operands.slice(1).map((operand) => operand.text).join(',');
    expressionSpan = statement.operands[1].span;
  } else if (statement.operands.length === 1) {
    // GNU-compatible whitespace form: `.eqv NAME expression`
    const match = /^([A-Za-z_.$][A-Za-z0-9_.$]*)\s+(.+)$/.exec(statement.operands[0].text);
    if (match) {
      name = match[1];
      expression = match[2].trim();
      expressionSpan = {
        sourceId: statement.operands[0].span.sourceId,
        startOffset: statement.operands[0].span.startOffset + statement.operands[0].text.indexOf(match[2]),
        endOffset: statement.operands[0].span.endOffset
      };
    }
  }
  if (!name || !expression) {
    state.diagnostics.push(assemblerDiagnostic(
      'asm.operand.wrong-count',
      '.eqv 需要名称和表达式',
      statementSpan(statement),
      statement.expansionStack
    ));
    return;
  }
  if (!/^[A-Za-z_.$][A-Za-z0-9_.$]*$/.test(name) || parseGprRegister(name) !== undefined) {
    state.diagnostics.push(assemblerDiagnostic('asm.symbol.duplicate', `非法的 .eqv 名称 ${name}`, statement.operands[0].span, statement.expansionStack));
    return;
  }
  const existing = state.labels.get(name) ?? state.eqvs.get(name);
  if (existing) {
    state.diagnostics.push(assemblerDiagnostic('asm.symbol.duplicate', `重复的符号 ${name}`, statement.operands[0].span, statement.expansionStack));
    return;
  }
  state.eqvs.set(name, {
    name,
    kind: 'eqv',
    expression,
    span: expressionSpan
  });
}

function processNumericDataDirective(statement: ParsedStatement, mnemonic: '.word' | '.half' | '.byte', state: AssemblyState): void {
  const width = mnemonic === '.word' ? 4 : mnemonic === '.half' ? 2 : 1;
  if (!statement.operands.length) {
    state.diagnostics.push(assemblerDiagnostic('asm.operand.wrong-count', `${mnemonic} 至少需要一个操作数`, statementSpan(statement), statement.expansionStack));
    return;
  }
  const origin = workOriginFor(statement);
  for (const operand of statement.operands) {
    const repetition = parseDataRepetition(operand.text);
    if (repetition) {
      const count = requiredInteger({ text: repetition.count, span: repetition.span } as ParsedOperand, state, 1, 0x0010_0000);
      if (!count.ok) {
        state.diagnostics.push(assemblerDiagnostic('asm.data.value-out-of-range', `${mnemonic} 重复次数无效：${repetition.count}`, operand.span, statement.expansionStack));
        continue;
      }
      for (let index = 0; index < count.value; index++) {
        allocateDataValue(state, width, repetition.value, operand.span, origin);
      }
      continue;
    }
    allocateDataValue(state, width, operand.text, operand.span, origin);
  }
}

function allocateDataValue(
  state: AssemblyState,
  width: 1 | 2 | 4,
  expression: string,
  span: SourceSpan,
  origin: WorkInstruction['origin'],
  isFloat = false
): void {
  try {
    const oldAddress = state.builder.cursor('data');
    const address = state.builder.appendDataBytes(new Array<number>(width).fill(0), origin, width);
    fixDataLabelsFrom(state, oldAddress, address);
    state.dataPatches.push({
      address,
      width,
      expression,
      span,
      origin,
      ...(isFloat ? { float: true } : {})
    });
  } catch (error) {
    state.diagnostics.push(diagnosticForError('asm.section.outside-course-address-space', error, span, origin.expansionStack));
  }
}

function processFloatDataDirective(statement: ParsedStatement, mnemonic: '.float' | '.double', state: AssemblyState): void {
  if (!statement.operands.length) {
    state.diagnostics.push(assemblerDiagnostic('asm.operand.wrong-count', `${mnemonic} 至少需要一个操作数`, statementSpan(statement), statement.expansionStack));
    return;
  }
  const width = mnemonic === '.float' ? 4 : 8;
  const origin = workOriginFor(statement);
  for (const operand of statement.operands) {
    const repetition = parseDataRepetition(operand.text);
    if (repetition) {
      const count = requiredInteger({ text: repetition.count, span: repetition.span } as ParsedOperand, state, 1, 0x0010_0000);
      if (!count.ok) {
        state.diagnostics.push(assemblerDiagnostic('asm.data.value-out-of-range', `${mnemonic} 重复次数无效：${repetition.count}`, operand.span, statement.expansionStack));
        continue;
      }
      for (let index = 0; index < count.value; index++) {
        allocateDataValue(state, width as 1 | 2 | 4, repetition.value, operand.span, origin, true);
      }
      continue;
    }
    allocateDataValue(state, width as 1 | 2 | 4, operand.text, operand.span, origin, true);
  }
}

function processStringDataDirective(statement: ParsedStatement, mnemonic: '.ascii' | '.asciiz', state: AssemblyState): void {
  if (!statement.operands.length) {
    state.diagnostics.push(assemblerDiagnostic('asm.operand.wrong-count', `${mnemonic} 至少需要一个字符串操作数`, statementSpan(statement), statement.expansionStack));
    return;
  }
  const origin = workOriginFor(statement);
  for (const operand of statement.operands) {
    const bytes = parseStringLiteralBytes(operand.text);
    if (!bytes) {
      state.diagnostics.push(assemblerDiagnostic('asm.data.invalid-string', `无效的字符串字面量 ${operand.text}`, operand.span, statement.expansionStack));
      continue;
    }
    try {
      state.builder.appendDataBytes([...bytes, ...(mnemonic === '.asciiz' ? [0] : [])], origin);
    } catch (error) {
      state.diagnostics.push(diagnosticForError('asm.section.outside-course-address-space', error, operand.span, statement.expansionStack));
    }
  }
}

function parseDataRepetition(text: string): { value: string; count: string; span: SourceSpan } | undefined {
  const match = /^(.*):\s*([^:]+)$/.exec(text.trim());
  if (!match) return undefined;
  // Only numeric directives use `value:count`; strings with colons are untouched.
  if (match[1].trim().startsWith('"')) return undefined;
  return {
    value: match[1].trim(),
    count: match[2].trim(),
    span: { sourceId: '', startOffset: 0, endOffset: 0 }
  };
}

// ── pass 1: instruction expansion ────────────────────────────────────────────

interface WorkResult {
  readonly ok: boolean;
  readonly instructions?: readonly WorkInstruction[];
  readonly diagnostic?: AssemblerDiagnostic;
}

function statementWork(statement: ParsedStatement, state: AssemblyState): WorkResult {
  const mnemonic = statement.mnemonic?.toLowerCase() ?? '';
  const parsedOperands = statement.operands.map((operand) => parseInstructionOperand(operand.text, operand.span));
  if (mnemonic === '_co_internal_unknown_instruction'
    && state.options.p7RiInstruction
    && state.profile === 'P7'
    && parsedOperands.length === 0) {
    return {
      ok: true,
      instructions: [{
        mnemonic,
        operands: [],
        origin: workOriginFor(statement),
        pseudo: false
      }]
    };
  }
  const entry = isaInstructionByMnemonic.get(mnemonic);

  if (!entry) {
    if (!mnemonic) {
      return { ok: false, diagnostic: assemblerDiagnostic('asm.syntax.invalid-statement', '无法识别的语句', statementSpan(statement), statement.expansionStack) };
    }
    const expansionOptions = pseudoOptions(state);
    const expansion = expandPseudoInstruction(
      { mnemonic, operands: parsedOperands },
      statement,
      expansionOptions
    );
    if (!expansion.ok) {
      return {
        ok: false,
        diagnostic: assemblerDiagnostic(
          /不支持的 pseudo/.test(expansion.error ?? '') ? 'asm.pseudo.unsupported' : 'asm.instruction.unknown',
          expansion.error ?? `未知指令 ${mnemonic}`,
          statement.mnemonicSpan,
          statement.expansionStack
        )
      };
    }
    return { ok: true, instructions: expansion.instructions };
  }

  if (!state.layers.includes(entry.layer)) {
    return {
      ok: false,
      diagnostic: assemblerDiagnostic(
        'asm.instruction.layer-unsupported',
        `${mnemonic} 属于未启用的指令层 ${entry.layer}`,
        statement.mnemonicSpan,
        statement.expansionStack
      )
    };
  }

  if (isLoadStoreMnemonic(mnemonic) && parsedOperands.length === 2 && parsedOperands[1].kind === 'memory'
    && memoryOffsetNeedsPseudo(parsedOperands[1].offsetText, state)) {
    const pseudoExpansion = expandLoadStorePseudo(mnemonic, parsedOperands, statement, false);
    if (pseudoExpansion) return { ok: true, instructions: pseudoExpansion };
  }

  const immediateExpansion = oversizedImmediatePseudo(mnemonic, parsedOperands);
  if (immediateExpansion.ok) return immediateExpansion;

  const real = tryRealInstruction(mnemonic, entry, parsedOperands, statement);
  if (real.ok && real.instructions) return { ok: true, instructions: real.instructions };

  // MARS pseudo forms sharing a real mnemonic.
  const pseudoExpansion = expandSharedMnemonicPseudo(mnemonic, parsedOperands, statement);
  if (pseudoExpansion.ok) return pseudoExpansion;

  return {
    ok: false,
    diagnostic: assemblerDiagnostic(
      'asm.operand.wrong-count',
      `${mnemonic} 操作数形式不合法：${statement.operandText}`,
      statement.mnemonicSpan,
      statement.expansionStack
    )
  };
}

function tryRealInstruction(
  mnemonic: string,
  entry: IsaInstructionEntry,
  parsedOperands: readonly ReturnType<typeof parseInstructionOperand>[],
  statement: ParsedStatement
): WorkResult {
  const forms = realInstructionForms(mnemonic, entry);
  let operands: readonly ParsedInstructionOperand[] = parsedOperands;
  if (mnemonic === 'jalr' && operands.length === 1 && operands[0].kind === 'register') {
    operands = [
      { kind: 'register', register: 31, span: operands[0].span },
      operands[0]
    ];
  }
  if (operands.length !== forms.length) {
    return { ok: false, diagnostic: undefined };
  }
  const workOperands: WorkOperand[] = [];
  for (let index = 0; index < forms.length; index++) {
    const form = forms[index];
    const operand = operands[index];
    switch (form.kind) {
      case 'register':
        if (operand.kind !== 'register') return { ok: false, diagnostic: undefined };
        workOperands.push({ kind: 'register', register: operand.register, span: operand.span });
        break;
      case 'shamt':
        if (operand.kind !== 'immediate') return { ok: false, diagnostic: undefined };
        workOperands.push({ kind: 'immediate', expression: operand.text, span: operand.span });
        break;
      case 'immediate':
        if (operand.kind !== 'immediate' && operand.kind !== 'character') return { ok: false, diagnostic: undefined };
        workOperands.push({ kind: 'immediate', expression: operand.text, span: operand.span });
        break;
      case 'label':
        if (operand.kind !== 'immediate') return { ok: false, diagnostic: undefined };
        workOperands.push({ kind: 'label', expression: operand.text, span: operand.span });
        break;
      case 'memory': {
        if (operand.kind === 'memory') {
          workOperands.push({
            kind: 'memory',
            baseRegister: operand.baseRegister,
            offsetExpression: operand.offsetText,
            offsetSpan: operand.offsetSpan,
            span: operand.span
          });
          break;
        }
        const bare = operand.kind === 'immediate' ? parseBareMemoryOperand(operand.text, operand.span) : undefined;
        if (!bare) return { ok: false, diagnostic: undefined };
        workOperands.push(bare);
        break;
      }
      case 'cp0': {
        // `$12/$13/$14` is ambiguous at the token level; MIPS course syntax uses
        // the same spelling for the CP0 operand. Context resolves it here, and a
        // bare register number is accepted as the MARS CP0-number form.
        let cp0Register: number | undefined;
        if (operand.kind === 'cp0' || operand.kind === 'register') {
          cp0Register = operand.register;
        } else if (operand.kind === 'immediate') {
          cp0Register = parseCp0Register(operand.text);
          if (cp0Register === undefined) {
            const parsed = parseIntegerLiteral(operand.text);
            if (parsed !== undefined && parsed >= 0 && parsed <= 31) cp0Register = parsed;
          }
        }
        if (cp0Register === undefined) return { ok: false, diagnostic: undefined };
        workOperands.push({ kind: 'cp0', register: cp0Register, span: operand.span });
        break;
      }
    }
  }
  return {
    ok: true,
    instructions: [{
      mnemonic,
      operands: workOperands,
      origin: workOriginFor(statement),
      pseudo: false
    }]
  };
}

function parseBareMemoryOperand(text: string, span: SourceSpan): WorkOperand | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    const base = parseGprRegister(trimmed.slice(1, -1).trim());
    if (base === undefined) return undefined;
    return { kind: 'memory', baseRegister: base, offsetExpression: '0', offsetSpan: span, span };
  }
  return undefined;
}

function expandSharedMnemonicPseudo(
  mnemonic: string,
  operands: readonly ReturnType<typeof parseInstructionOperand>[],
  statement: ParsedStatement
): WorkResult {
  const instructionSet = new Set([
    'add', 'addu', 'sub', 'subu', 'and', 'or', 'xor',
    'lw', 'lwl', 'lwr', 'sw', 'swl', 'swr', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh',
    'beq', 'bne', 'addi', 'addiu', 'andi', 'ori', 'xori'
  ]);
  if (!instructionSet.has(mnemonic)) return { ok: false, diagnostic: undefined };

  if (mnemonic === 'beq' || mnemonic === 'bne') {
    const expansion = expandBranchImmediatePseudo(mnemonic, operands, statement);
    if (expansion) return { ok: true, instructions: expansion };
    return { ok: false, diagnostic: undefined };
  }

  if (['add', 'addu', 'sub', 'subu', 'and', 'or', 'xor'].includes(mnemonic)) {
    const expansion = expandAluImmediatePseudo(mnemonic, operands, statement);
    if (expansion) return { ok: true, instructions: expansion };
    if (['and', 'or', 'xor'].includes(mnemonic)) {
      const two = expandTwoOperandLogicalPseudo(mnemonic, operands, statement);
      if (two) return { ok: true, instructions: two };
    }
    return { ok: false, diagnostic: undefined };
  }

  if (['lw', 'lwl', 'lwr', 'sw', 'swl', 'swr', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh'].includes(mnemonic)) {
    const expansion = expandLoadStorePseudo(mnemonic, operands, statement, false);
    if (expansion) return { ok: true, instructions: expansion };
    return { ok: false, diagnostic: undefined };
  }

  // addi/addiu/andi/ori/xori with an out-of-range immediate or a two-operand form.
  if (operands.length === 3 && operands[2].kind === 'immediate') {
    const value = parseIntegerLiteral(operands[2].text);
    const unsignedMnemonic = ['andi', 'ori', 'xori'].includes(mnemonic);
    const oversized = value !== undefined && (
      unsignedMnemonic
        ? value < 0 || (value >>> 0) > 65535
        : value < -32768 || value > 32767
    );
    if (oversized) {
      const high = Math.floor((value >>> 0) / 0x10000);
      const low = (value >>> 0) & 0xffff;
      const origin = workOriginFor(statement);
      const at = (): WorkOperand => ({ kind: 'register', register: 1, span: operands[2].span });
      return {
        ok: true,
        instructions: [
          { mnemonic: 'lui', operands: [at(), { kind: 'immediate', expression: String(high), span: operands[2].span }], origin, pseudo: true, pseudoMnemonic: mnemonic },
          { mnemonic: 'ori', operands: [at(), at(), { kind: 'immediate', expression: String(low), span: operands[2].span }], origin, pseudo: true, pseudoMnemonic: mnemonic },
          {
            mnemonic: mnemonic === 'addi' ? 'add' : mnemonic === 'addiu' ? 'addu' : mnemonic.slice(0, -1),
            operands: [operandToWork(operands[0]), operandToWork(operands[1]), at()],
            origin,
            pseudo: true,
            pseudoMnemonic: mnemonic
          }
        ]
      };
    }
  }
  if (operands.length === 2 && operands[1].kind === 'immediate' && ['andi', 'ori', 'xori', 'addi', 'addiu'].includes(mnemonic)) {
    const origin = workOriginFor(statement);
    return {
      ok: true,
      instructions: [{
        mnemonic,
        operands: [operandToWork(operands[0]), operandToWork(operands[0]), { kind: 'immediate', expression: operands[1].text, span: operands[1].span }],
        origin,
        pseudo: true,
        pseudoMnemonic: mnemonic
      }]
    };
  }
  return { ok: false, diagnostic: undefined };
}

function oversizedImmediatePseudo(
  mnemonic: string,
  operands: readonly ParsedInstructionOperand[]
): WorkResult {
  const immediateMnemonics = new Set(['addi', 'addiu', 'andi', 'ori', 'xori']);
  if (!immediateMnemonics.has(mnemonic) || operands.length !== 3 || operands[2].kind !== 'immediate') {
    return { ok: false, diagnostic: undefined };
  }
  const value = parseIntegerLiteral(operands[2].text);
  if (value === undefined) return { ok: false, diagnostic: undefined };
  const signedKind = ['addi', 'addiu'].includes(mnemonic) ? 'signed' : 'unsigned';
  const oversized = signedKind === 'signed'
    ? value < -32768 || value > 32767
    : value < 0 || (value >>> 0) > 65535;
  if (!oversized) return { ok: false, diagnostic: undefined };
  const statement = {
    kind: 'statement',
    sourceId: operands[0].span.sourceId,
    line: 0,
    startOffset: operands[0].span.startOffset,
    endOffset: operands[operands.length - 1].span.endOffset,
    text: '',
    code: '',
    labels: [],
    mnemonic,
    operandText: '',
    operands: [],
    expansionStack: []
  } satisfies ParsedStatement;
  // expandSharedMnemonicPseudo only needs operands and statement origin fields.
  return expandSharedMnemonicPseudo(mnemonic, operands, statement);
}

function isLoadStoreMnemonic(mnemonic: string): boolean {
  return ['lw', 'lwl', 'lwr', 'sw', 'swl', 'swr', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh'].includes(mnemonic);
}

/** True when a memory offset is a label expression that MARS expands in non-compact configs. */
function memoryOffsetNeedsPseudo(expression: string, state: AssemblyState): boolean {
  if (parseIntegerLiteral(expression) !== undefined) return false;
  // MARS performs .eqv substitution during tokenization, so only a resolvable
  // .eqv turns a memory offset into a plain immediate. A label token stays a
  // pseudo address form even when its address is already known.
  const evaluation = evaluateExpression(expression, makeEqvOnlyResolver(state), { unresolvedIsError: true });
  return !evaluation.ok;
}

function makeEqvOnlyResolver(state: AssemblyState): { resolve(name: string): number | undefined } {
  return {
    resolve: (name: string): number | undefined => {
      if (!state.eqvs.has(name)) return undefined;
      return resolveEqv(name, state);
    }
  };
}

function operandToWork(operand: ReturnType<typeof parseInstructionOperand>): WorkOperand {
  switch (operand.kind) {
    case 'register': return { kind: 'register', register: operand.register, span: operand.span };
    case 'cp0': return { kind: 'cp0', register: operand.register, span: operand.span };
    case 'memory': return { kind: 'memory', baseRegister: operand.baseRegister, offsetExpression: operand.offsetText, offsetSpan: operand.offsetSpan, span: operand.span };
    case 'immediate':
    case 'character': return { kind: 'immediate', expression: operand.text, span: operand.span };
    default: return { kind: 'immediate', expression: operand.text, span: operand.span };
  }
}

function pseudoOptions(state: AssemblyState): PseudoExpansionOptions {
  return {
    profile: state.profile,
    // Course MARS runs use FixedCompactLargeText/CompactLargeText; neither is
    // classified as the 16-bit "Compact" pseudo-expansion model by MARS.
    compactAddresses: false,
    maximumInstructionsPerStatement: state.options.maximumPseudoInstructionsPerStatement
  };
}

// ── pass 1: layout ───────────────────────────────────────────────────────────

function layoutInstruction(
  instruction: WorkInstruction,
  section: 'text' | 'ktext',
  state: AssemblyState
): { diagnostic?: AssemblerDiagnostic } {
  try {
    const appended = state.builder.appendInstruction(section, 0, instruction.origin);
    state.instructionPatches.push({
      instruction,
      section,
      wordIndex: appended.wordIndex,
      address: state.builder.cursor(section) - 4
    });
    return {};
  } catch (error) {
    return {
      diagnostic: diagnosticForError(
        error instanceof Error && /重叠/.test(error.message) ? 'asm.section.segment-overlap' : 'asm.section.outside-course-address-space',
        error,
        instruction.origin.span,
        instruction.origin.expansionStack
      )
    };
  }
}

// ── pass 2: encoding ─────────────────────────────────────────────────────────

function encodeWorkInstruction(
  instruction: WorkInstruction,
  address: number,
  state: AssemblyState
): { word?: number; diagnostic?: AssemblerDiagnostic } {
  if (instruction.mnemonic === '_co_internal_unknown_instruction') {
    return { word: 0x0000_003f };
  }
  const entry = isaInstructionByMnemonic.get(instruction.mnemonic);
  if (!entry) {
    return {
      diagnostic: assemblerDiagnostic(
        'asm.instruction.unknown',
        `展开后的未知指令 ${instruction.mnemonic}`,
        instruction.origin.span,
        instruction.origin.expansionStack
      )
    };
  }
  const operands = instruction.operands;
  const forms = realInstructionForms(instruction.mnemonic, entry);
  if (operands.length !== forms.length) {
    return {
      diagnostic: assemblerDiagnostic(
        'asm.operand.wrong-count',
        `${instruction.mnemonic} 需要 ${forms.length} 个操作数，展开得到 ${operands.length}`,
        instruction.origin.span,
        instruction.origin.expansionStack
      )
    };
  }
  const encode: EncodeOperands = {};
  for (let index = 0; index < forms.length; index++) {
    const form = forms[index];
    const operand = operands[index];
    switch (form.kind) {
      case 'register': {
        if (operand.kind !== 'register') return invalidOperand(instruction, `操作数 ${index + 1} 必须是寄存器`);
        const role = form.role;
        encode[role] = operand.register;
        break;
      }
      case 'shamt': {
        const value = evaluateImmediate(operand, state, instruction);
        if (value.diagnostic) return { diagnostic: value.diagnostic };
        if (value.value! < 0 || value.value! > 31) {
          return rangeDiagnostic(instruction, `移位量 ${value.value} 超出 0..31`, operand);
        }
        encode.shamt = value.value;
        break;
      }
      case 'immediate': {
        const value = evaluateImmediate(operand, state, instruction);
        if (value.diagnostic) return { diagnostic: value.diagnostic };
        const signedKind = immediateSignedKind(instruction.mnemonic);
        if (signedKind === 'signed' && (value.value! < -32768 || value.value! > 32767)) {
          return rangeDiagnostic(instruction, `立即数 ${value.value} 超出有符号 16 位范围`, operand);
        }
        if (signedKind === 'unsigned' && (value.value! < 0 || value.value! > 65535)) {
          return rangeDiagnostic(instruction, `立即数 ${value.value} 超出无符号 16 位范围`, operand);
        }
        encode.immediate = value.value;
        break;
      }
      case 'label': {
        if (operand.kind !== 'label' && operand.kind !== 'immediate') return invalidOperand(instruction, `操作数 ${index + 1} 必须是地址表达式`);
        const target = evaluateImmediate(operand, state, instruction);
        if (target.diagnostic) return { diagnostic: target.diagnostic };
        const targetAddress = u32(target.value!);
        if ((targetAddress & 3) !== 0) {
          return rangeDiagnostic(instruction, `跳转目标 ${targetAddress.toString(16)} 未字对齐`, operand);
        }
        if (entry.formatKind === 'j') {
          encode.index = (targetAddress >>> 2) & 0x03ff_ffff;
        } else {
          const branchBase = u32(address + 4);
          const delta = targetAddress - branchBase;
          if ((delta & 3) !== 0) {
            return rangeDiagnostic(instruction, `分支目标 ${targetAddress.toString(16)} 与 ${branchBase.toString(16)} 的差不是 4 的倍数`, operand);
          }
          const offset = delta >> 2;
          if (offset < -32768 || offset > 32767) {
            return rangeDiagnostic(instruction, `分支偏移 ${offset} 超出有符号 16 位范围`, operand);
          }
          encode.immediate = offset;
        }
        break;
      }
      case 'memory': {
        if (operand.kind !== 'memory') return invalidOperand(instruction, `操作数 ${index + 1} 必须是 offset($base)`);
        const offset = evaluateImmediate({ kind: 'immediate', expression: operand.offsetExpression, span: operand.offsetSpan }, state, instruction);
        if (offset.diagnostic) return { diagnostic: offset.diagnostic };
        if (offset.value! < -32768 || offset.value! > 32767) {
          return rangeDiagnostic(instruction, `访存偏移 ${offset.value} 超出有符号 16 位范围`, operand);
        }
        encode.rs = operand.baseRegister;
        encode.immediate = offset.value;
        break;
      }
      case 'cp0': {
        if (operand.kind !== 'cp0') return invalidOperand(instruction, `操作数 ${index + 1} 必须是 CP0 寄存器`);
        encode.rd = operand.register;
        break;
      }
    }
  }
  try {
    return { word: encodeInstructionWord(instruction.mnemonic, encode) };
  } catch (error) {
    if (error instanceof InstructionEncodeError) {
      return {
        diagnostic: assemblerDiagnostic(
          'asm.instruction.canonical-encoding-violation',
          error.message,
          instruction.origin.span,
          instruction.origin.expansionStack
        )
      };
    }
    throw error;
  }
}

function encodeDataPatch(
  patch: DataPatch,
  state: AssemblyState
): { bytes?: number[]; diagnostic?: AssemblerDiagnostic } {
  if (patch.float) {
    const bytes = floatBytes(patch.expression, patch.width as 4 | 8);
    if (!bytes) {
      return {
        diagnostic: assemblerDiagnostic(
          'asm.data.value-out-of-range',
          `无效的浮点字面量 ${patch.expression}`,
          patch.span,
          patch.origin.expansionStack
        )
      };
    }
    return { bytes: [...bytes] };
  }
  const evaluation = evaluateExpression(patch.expression, makeSymbolResolver(state), { unresolvedIsError: true });
  if (!evaluation.ok) {
    return {
      diagnostic: assemblerDiagnostic(
        evaluation.unresolvedSymbols?.length ? 'asm.symbol.undefined' : 'asm.operand.invalid-immediate',
        evaluation.unresolvedSymbols?.length
          ? `未定义符号 ${evaluation.unresolvedSymbols.join(', ')}`
          : evaluation.error ?? '数据表达式求值失败',
        patch.span,
        patch.origin.expansionStack
      )
    };
  }
  const value = evaluation.value!;
  const bytes: number[] = [];
  let bits = value >>> 0;
  if (patch.width === 1 && (value < -128 || value > 255)) {
    return { diagnostic: assemblerDiagnostic('asm.data.value-out-of-range', `.byte 值 ${value} 超出 8 位范围`, patch.span, patch.origin.expansionStack) };
  }
  if (patch.width === 2 && (value < -32768 || value > 65535)) {
    return { diagnostic: assemblerDiagnostic('asm.data.value-out-of-range', `.half 值 ${value} 超出 16 位范围`, patch.span, patch.origin.expansionStack) };
  }
  for (let byte = 0; byte < patch.width; byte++) {
    bytes.push((bits >>> (byte * 8)) & 0xff);
  }
  return { bytes };
}

function floatBytes(text: string, width: 4 | 8): Uint8Array | undefined {
  const value = Number(text.trim());
  if (!Number.isFinite(value)) return undefined;
  const buffer = new ArrayBuffer(width);
  const view = new DataView(buffer);
  if (width === 4) view.setFloat32(0, value, true);
  else view.setFloat64(0, value, true);
  return new Uint8Array(buffer);
}

function evaluateImmediate(
  operand: WorkOperand,
  state: AssemblyState,
  instruction: WorkInstruction
): { value?: number; diagnostic?: AssemblerDiagnostic } {
  if (operand.kind !== 'immediate' && operand.kind !== 'label' && operand.kind !== 'memory') {
    return { diagnostic: invalidOperand(instruction, '内部错误：期望表达式操作数').diagnostic };
  }
  const expression = operand.kind === 'memory' ? operand.offsetExpression : operand.expression;
  const span = operand.kind === 'memory' ? operand.offsetSpan : operand.span;
  const evaluation = evaluateExpression(expression, makeSymbolResolver(state), { unresolvedIsError: true });
  if (!evaluation.ok) {
    return {
      diagnostic: assemblerDiagnostic(
        evaluation.unresolvedSymbols?.length ? 'asm.symbol.undefined' : 'asm.operand.invalid-immediate',
        evaluation.unresolvedSymbols?.length
          ? `未定义符号 ${evaluation.unresolvedSymbols.join(', ')}`
          : evaluation.error ?? '表达式求值失败',
        span,
        instruction.origin.expansionStack
      )
    };
  }
  return { value: evaluation.value };
}

function immediateSignedKind(mnemonic: string): 'signed' | 'unsigned' | 'none' {
  switch (mnemonic) {
    case 'andi':
    case 'ori':
    case 'xori':
    case 'lui':
      return mnemonic === 'lui' ? 'unsigned' : 'unsigned';
    case 'sltiu':
      return 'signed';
    default:
      return 'signed';
  }
}

function invalidOperand(instruction: WorkInstruction, message: string): { diagnostic: AssemblerDiagnostic } {
  return {
    diagnostic: assemblerDiagnostic(
      'asm.operand.invalid-register',
      `${instruction.mnemonic}: ${message}`,
      instruction.origin.span,
      instruction.origin.expansionStack
    )
  };
}

function rangeDiagnostic(instruction: WorkInstruction, message: string, _operand: WorkOperand): { diagnostic: AssemblerDiagnostic } {
  return {
    diagnostic: assemblerDiagnostic(
      'asm.immediate.out-of-range',
      `${instruction.mnemonic}: ${message}`,
      instruction.origin.span,
      instruction.origin.expansionStack
    )
  };
}

// ── symbol resolution ────────────────────────────────────────────────────────

function makeSymbolResolver(state: AssemblyState): { resolve(name: string): number | undefined } {
  return {
    resolve: (name: string): number | undefined => {
      const label = state.labels.get(name);
      if (label) return label.value;
      const eqv = state.eqvs.get(name);
      if (!eqv) return undefined;
      return resolveEqv(name, state);
    }
  };
}

function resolveEqv(name: string, state: AssemblyState): number {
  const evaluate = (symbolName: string, stack: Set<string>): number => {
    if (stack.has(symbolName)) {
      throw new Error(`.eqv 循环引用 ${[...stack, symbolName].join(' -> ')}`);
    }
    const label = state.labels.get(symbolName);
    if (label) return label.value;
    const eqv = state.eqvs.get(symbolName);
    if (!eqv) throw new Error(`未定义符号 ${symbolName}`);
    const nextStack = new Set(stack);
    nextStack.add(symbolName);
    const result = evaluateExpression(eqv.expression, {
      resolve: (nested) => (nested === symbolName || state.labels.has(nested) || state.eqvs.has(nested) ? evaluate(nested, nextStack) : undefined)
    }, { unresolvedIsError: true });
    if (!result.ok) throw new Error(result.error ?? `无法求值 .eqv ${symbolName}`);
    return result.value!;
  };
  return evaluate(name, new Set());
}

// ── helpers ──────────────────────────────────────────────────────────────────

function setSectionCursor(
  state: AssemblyState,
  section: CourseSectionId,
  address: number,
  span: SourceSpan,
  expansionStack: readonly SourceSpan[]
): void {
  try {
    state.builder.setCursor(section, u32(address));
  } catch (error) {
    state.diagnostics.push(diagnosticForError(
      error instanceof Error && /未字对齐/.test(error.message)
        ? 'asm.section.misaligned-base'
        : 'asm.section.outside-course-address-space',
      error,
      span,
      expansionStack
    ));
  }
}

function requiredInteger(
  operand: ParsedOperand,
  state: AssemblyState,
  min: number,
  max: number
): { ok: true; value: number } | { ok: false } {
  const parsed = parseIntegerLiteral(operand.text);
  if (parsed === undefined) {
    const evaluation = evaluateExpression(operand.text, makeSymbolResolver(state), { unresolvedIsError: true });
    if (!evaluation.ok) return { ok: false };
    const value = evaluation.value!;
    if (value < min || value > max) return { ok: false };
    return { ok: true, value };
  }
  if (parsed < min || parsed > max) return { ok: false };
  return { ok: true, value: parsed };
}

function diagnosticForError(
  code: AssemblerDiagnosticCode,
  error: unknown,
  span: SourceSpan,
  expansionStack: readonly SourceSpan[]
): AssemblerDiagnostic {
  return assemblerDiagnostic(
    code,
    error instanceof Error ? error.message : String(error),
    span,
    expansionStack
  );
}

function statementSpan(statement: ParsedStatement): SourceSpan {
  return { sourceId: statement.sourceId, startOffset: statement.startOffset, endOffset: statement.endOffset };
}
