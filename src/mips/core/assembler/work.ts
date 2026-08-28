// @index mips-core — 汇编器工作 IR：section 无关的 instruction/relocation 中间表示（纯 TS）

import { SourceSpan } from './diagnostics';
import { ParsedStatement } from './syntax';

export interface WorkOrigin {
  readonly span: SourceSpan;
  readonly expansionStack: readonly SourceSpan[];
}

export type WorkOperand =
  | { readonly kind: 'register'; readonly register: number; readonly span: SourceSpan }
  | { readonly kind: 'cp0'; readonly register: number; readonly span: SourceSpan }
  | { readonly kind: 'immediate'; readonly expression: string; readonly span: SourceSpan }
  | { readonly kind: 'memory'; readonly baseRegister: number; readonly offsetExpression: string; readonly offsetSpan: SourceSpan; readonly span: SourceSpan }
  | { readonly kind: 'label'; readonly expression: string; readonly span: SourceSpan };

export interface WorkInstruction {
  readonly mnemonic: string;
  readonly operands: readonly WorkOperand[];
  readonly origin: WorkOrigin;
  /** True when this instruction came from a pseudo expansion. */
  readonly pseudo: boolean;
  readonly pseudoMnemonic?: string;
}

export interface WorkStatement {
  readonly origin: WorkOrigin;
  readonly labels: readonly { readonly name: string; readonly span: SourceSpan }[];
  readonly instruction?: WorkInstruction;
  readonly expansionIndex?: number;
}

export function workOriginFor(statement: ParsedStatement): WorkOrigin {
  return {
    span: {
      sourceId: statement.sourceId,
      startOffset: statement.startOffset,
      endOffset: statement.endOffset
    },
    expansionStack: statement.expansionStack
  };
}
