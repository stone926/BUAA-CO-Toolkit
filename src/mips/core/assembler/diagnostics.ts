// @index mips-core — 严格汇编器稳定诊断：code、SourceSpan 与 origin chain（纯 TS）

/** Offset-based source span. Offsets are UTF-16 code units in the original unit text. */
export interface SourceSpan {
  readonly sourceId: string;
  readonly startOffset: number;
  readonly endOffset: number;
}

/** One frame of macro/include expansion provenance, innermost first. */
export type ExpansionOrigin = SourceSpan;

export interface AssemblerDiagnostic {
  /** Stable machine-readable code; LSP/VS Code adapters render the message. */
  readonly code: string;
  readonly message: string;
  readonly span?: SourceSpan;
  /** Innermost-first expansion stack. `span` is the leaf origin. */
  readonly expansionStack?: readonly ExpansionOrigin[];
}

export type AssemblerDiagnosticCode =
  | 'asm.syntax.empty-statement'
  | 'asm.syntax.invalid-statement'
  | 'asm.syntax.unterminated-string'
  | 'asm.syntax.invalid-label'
  | 'asm.syntax.unknown-directive'
  | 'asm.syntax.directive-in-text'
  | 'asm.syntax.directive-in-data'
  | 'asm.syntax.macro-definition-mismatch'
  | 'asm.operand.wrong-count'
  | 'asm.operand.invalid-register'
  | 'asm.operand.invalid-cp0-register'
  | 'asm.operand.invalid-memory-operand'
  | 'asm.operand.invalid-immediate'
  | 'asm.operand.invalid-label-expression'
  | 'asm.instruction.unknown'
  | 'asm.instruction.profile-unsupported'
  | 'asm.instruction.layer-unsupported'
  | 'asm.instruction.canonical-encoding-violation'
  | 'asm.immediate.out-of-range'
  | 'asm.symbol.duplicate'
  | 'asm.symbol.undefined'
  | 'asm.symbol.eqv-cycle'
  | 'asm.section.outside-course-address-space'
  | 'asm.section.segment-overlap'
  | 'asm.section.too-many-words'
  | 'asm.section.misaligned-base'
  | 'asm.data.unaligned-string-word'
  | 'asm.data.value-out-of-range'
  | 'asm.data.invalid-string'
  | 'asm.include.not-found'
  | 'asm.include.cycle'
  | 'asm.include.too-deep'
  | 'asm.include.too-many-units'
  | 'asm.macro.undefined'
  | 'asm.macro.argument-count'
  | 'asm.macro.recursion-limit'
  | 'asm.macro.expansion-limit'
  | 'asm.macro.duplicate-parameter'
  | 'asm.pseudo.unsupported'
  | 'asm.limit.source-bytes'
  | 'asm.internal-error';

export function assemblerDiagnostic(
  code: AssemblerDiagnosticCode,
  message: string,
  span?: SourceSpan,
  expansionStack?: readonly ExpansionOrigin[]
): AssemblerDiagnostic {
  return {
    code,
    message,
    ...(span ? { span } : {}),
    ...(expansionStack && expansionStack.length ? { expansionStack } : {})
  };
}
