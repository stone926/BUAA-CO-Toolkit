// @index verilog-generate-scopes — generate 块作用域查询（纯模型）：位置所在的 generate 块、按作用域区分的信号键、if/else 分支互斥判断

import type { Position } from 'vscode-languageserver/node';
import { containsPosition, containsRange } from '../common/lsp';
import type { VerilogGenerateBlock, VerilogModule } from './model';

/** Innermost generate block of `module` containing `position`. */
export function generateBlockAt(module: VerilogModule, position: Position): VerilogGenerateBlock | undefined {
  let innermost: VerilogGenerateBlock | undefined;
  for (const block of module.generateBlocks) {
    if (containsPosition(block.range, position) && (!innermost || containsRange(innermost.range, block.range))) {
      innermost = block;
    }
  }
  return innermost;
}

/**
 * Identity of the signal `name` referenced at `position`: a name declared in an
 * enclosing generate block is a different signal from a module-level (or another
 * block's) signal of the same name.
 */
export function generateSignalKey(module: VerilogModule, name: string, position: Position): string {
  let owner: VerilogGenerateBlock | undefined;
  for (const block of module.generateBlocks) {
    if (
      containsPosition(block.range, position) &&
      block.declarations.some((declaration) => declaration.name === name) &&
      (!owner || containsRange(owner.range, block.range))
    ) {
      owner = block;
    }
  }
  return owner ? `${name}@${owner.range.start.line}:${owner.range.start.character}` : name;
}

/** Whether code at `left` and `right` sits on different branches of one conditional generate, so never elaborates together. */
export function exclusiveGenerateBranches(module: VerilogModule, left: Position, right: Position): boolean {
  const leftBranches = generateBlockAt(module, left)?.branches ?? [];
  const rightBranches = generateBlockAt(module, right)?.branches ?? [];
  return leftBranches.some((outer) =>
    rightBranches.some((inner) => inner.construct === outer.construct && inner.branch !== outer.branch));
}

/** First element of `positions` (in order) that can coexist with an earlier one, i.e. a real conflict. */
export function firstConflictingIndex(module: VerilogModule, positions: readonly Position[]): number {
  for (let index = 1; index < positions.length; index++) {
    if (positions.slice(0, index).some((earlier) => !exclusiveGenerateBranches(module, earlier, positions[index]))) {
      return index;
    }
  }
  return -1;
}
