// @index waveform-tree — 由 scope/var 表构建信号浏览树：存储器字归并为数组节点、参数折叠、自然排序、搜索过滤与虚拟列表扁平化

import type { WaveformData, WaveVar } from '../model/waveformData';

export type TreeNodeKind = 'scope' | 'var' | 'array' | 'params';

export interface TreeNode {
  /** Stable across reloads of the same design. */
  readonly id: string;
  readonly kind: TreeNodeKind;
  readonly label: string;
  /** Short secondary text such as `[31:0]` or `32 × [31:0]`. */
  readonly detail?: string;
  /** Hierarchical path (scope path or var path). */
  readonly path: string;
  readonly varIndex?: number;
  readonly children: readonly TreeNode[];
}

export interface FlatTreeNode {
  readonly node: TreeNode;
  readonly depth: number;
  readonly expanded: boolean;
  readonly expandable: boolean;
  /** Matches the search query itself rather than being shown as an ancestor of a match. */
  readonly matched?: boolean;
}

const memoryWordPattern = /^(.+)\[(-?\d+)\]$/;
const parameterKinds = new Set(['parameter', 'localparam', 'specparam']);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Build the scope browser tree. */
export function buildSignalTree(data: WaveformData): TreeNode[] {
  const childScopes: number[][] = data.scopes.map(() => []);
  const scopeVars: number[][] = data.scopes.map(() => []);
  const roots: number[] = [];
  data.scopes.forEach((scope, index) => {
    if (scope.parent >= 0) {
      childScopes[scope.parent].push(index);
    } else {
      roots.push(index);
    }
  });
  data.vars.forEach((variable, index) => {
    if (variable.scope >= 0 && variable.scope < scopeVars.length) {
      scopeVars[variable.scope].push(index);
    }
  });
  const buildScope = (scopeIndex: number): TreeNode => {
    const scope = data.scopes[scopeIndex];
    const children: TreeNode[] = [
      ...childScopes[scopeIndex].map(buildScope),
      ...buildVarNodes(data, scope.path, scopeVars[scopeIndex])
    ];
    return { id: `s:${scope.path}`, kind: 'scope', label: scope.name, path: scope.path, children };
  };
  return roots.map(buildScope);
}

function buildVarNodes(data: WaveformData, scopePath: string, varIndexes: readonly number[]): TreeNode[] {
  const signals: TreeNode[] = [];
  const parameters: TreeNode[] = [];
  const arrays = new Map<string, number[]>();
  for (const index of varIndexes) {
    const variable = data.vars[index];
    const word = memoryWordPattern.exec(variable.name);
    if (word && !parameterKinds.has(variable.kind)) {
      const members = arrays.get(word[1]) ?? [];
      members.push(index);
      arrays.set(word[1], members);
      continue;
    }
    (parameterKinds.has(variable.kind) ? parameters : signals).push(varNode(variable, index));
  }
  for (const [base, members] of arrays) {
    if (members.length < 2) {
      signals.push(varNode(data.vars[members[0]], members[0]));
      continue;
    }
    members.sort((left, right) => wordIndex(data.vars[left]) - wordIndex(data.vars[right]));
    const sample = data.vars[members[0]];
    signals.push({
      id: `a:${scopePath}.${base}`,
      kind: 'array',
      label: base,
      detail: `${members.length} × ${sample.range ?? `${sample.width} 位`}`,
      path: `${scopePath}.${base}`,
      children: members.map((index) => varNode(data.vars[index], index))
    });
  }
  signals.sort((left, right) => collator.compare(left.label, right.label));
  parameters.sort((left, right) => collator.compare(left.label, right.label));
  if (parameters.length) {
    signals.push({
      id: `p:${scopePath}`,
      kind: 'params',
      label: '参数',
      detail: String(parameters.length),
      path: scopePath,
      children: parameters
    });
  }
  return signals;
}

function varNode(variable: WaveVar, index: number): TreeNode {
  return {
    id: `v:${variable.path}`,
    kind: 'var',
    label: variable.name,
    detail: variable.range ?? (variable.width > 1 ? `${variable.width} 位` : undefined),
    path: variable.path,
    varIndex: index,
    children: []
  };
}

function wordIndex(variable: WaveVar): number {
  const match = memoryWordPattern.exec(variable.name);
  return match ? Number(match[2]) : 0;
}

/** All var indexes below `node` (a var yields itself). */
export function collectVarIndexes(node: TreeNode, recursive: boolean): number[] {
  if (node.varIndex !== undefined) {
    return [node.varIndex];
  }
  const indexes: number[] = [];
  const visit = (parent: TreeNode): void => {
    for (const child of parent.children) {
      if (child.kind === 'var') {
        indexes.push(child.varIndex!);
      } else if (child.kind === 'array' || (recursive && child.kind === 'scope')) {
        visit(child);
      }
    }
  };
  visit(node);
  return indexes;
}

/**
 * Flatten the tree for a virtual list. With a non-empty `query`, only nodes whose
 * label or path contains it (case-insensitively) are kept, together with their
 * ancestors, which are shown expanded. `limit` bounds the result size.
 */
export function flattenSignalTree(
  roots: readonly TreeNode[],
  expanded: ReadonlySet<string>,
  query: string,
  limit = 5000
): { nodes: FlatTreeNode[]; truncated: boolean } {
  const nodes: FlatTreeNode[] = [];
  const needle = query.trim().toLowerCase();
  let truncated = false;
  if (!needle) {
    const visit = (node: TreeNode, depth: number): void => {
      if (nodes.length >= limit) {
        truncated = true;
        return;
      }
      const isExpanded = expanded.has(node.id);
      nodes.push({ node, depth, expanded: isExpanded, expandable: node.children.length > 0 });
      if (isExpanded) {
        for (const child of node.children) {
          visit(child, depth + 1);
        }
      }
    };
    roots.forEach((root) => visit(root, 0));
    return { nodes, truncated };
  }
  // A dotted query (`DEreg.E_PC`) matches against hierarchical paths as well.
  const matchPaths = needle.includes('.');
  const matches = (node: TreeNode): boolean =>
    node.label.toLowerCase().includes(needle) || (matchPaths && node.kind !== 'params' && node.path.toLowerCase().includes(needle));
  const visitFiltered = (node: TreeNode, depth: number): boolean => {
    if (nodes.length >= limit) {
      truncated = true;
      return false;
    }
    const selfMatches = matches(node);
    const position = nodes.length;
    const placeholder: FlatTreeNode = { node, depth, expanded: true, expandable: node.children.length > 0, matched: selfMatches };
    nodes.push(placeholder);
    let childMatched = false;
    if (!selfMatches || node.kind === 'scope') {
      for (const child of node.children) {
        childMatched = visitFiltered(child, depth + 1) || childMatched;
      }
    }
    if (!selfMatches && !childMatched) {
      nodes.length = position;
      return false;
    }
    if (selfMatches && !childMatched && node.children.length) {
      // A matching scope/array starts collapsed unless the user expanded it.
      nodes[position] = { ...placeholder, expanded: expanded.has(node.id) };
      if (expanded.has(node.id)) {
        for (const child of node.children) {
          visitAll(child, depth + 1);
        }
      }
    }
    return true;
  };
  const visitAll = (node: TreeNode, depth: number): void => {
    if (nodes.length >= limit) {
      truncated = true;
      return;
    }
    const isExpanded = expanded.has(node.id);
    nodes.push({ node, depth, expanded: isExpanded, expandable: node.children.length > 0 });
    if (isExpanded) {
      node.children.forEach((child) => visitAll(child, depth + 1));
    }
  };
  roots.forEach((root) => visitFiltered(root, 0));
  return { nodes, truncated };
}

/** Entry to select after a search: the first actual match, else the first entry (-1 when empty). */
export function firstMatchIndex(flat: readonly FlatTreeNode[]): number {
  const index = flat.findIndex((entry) => entry.matched);
  return index >= 0 ? index : Math.min(0, flat.length - 1);
}
