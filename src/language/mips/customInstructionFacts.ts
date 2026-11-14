// @index mips-lsp — Workspace-scoped custom ISA facts; no user code runs in the language server
import { URI } from 'vscode-uri';
import type { CustomInstructionMetadata, CustomInstructionMode } from '../../mips/core/custom/api';
import { CustomInstructionRegistry, createCustomInstructionMetadataRegistry } from '../../mips/core/custom/registry';
import { customAssemblerExtension } from '../../mips/core/custom/assembler';
import { parseAssemblerLine } from '../../mips/core/assembler/syntax';
import type { MipsInstruction } from './resources';

interface Facts { root: string; registry: CustomInstructionRegistry; revision: number }
const workspaces = new Map<string, Facts>();
const lookups = new Map<string, Facts | undefined>();
let revision = 0;
const uriKey = (uri: string) => { const key = URI.parse(uri).toString().replace(/\/$/, ''); return process.platform === 'win32' ? key.toLowerCase() : key; };
export function setCustomInstructionFacts(rootUri: string, metadata: readonly CustomInstructionMetadata[]): void {
  if (typeof rootUri !== 'string' || URI.parse(rootUri).scheme !== 'file' || !Array.isArray(metadata) || metadata.length > 256) throw new Error('Invalid custom instruction facts');
  const registry = createCustomInstructionMetadataRegistry(metadata);
  const root = uriKey(rootUri);
  workspaces.set(root, { root, registry, revision: ++revision });
  lookups.clear();
}
export function clearCustomInstructionFacts(): void { workspaces.clear(); lookups.clear(); revision++; }
function factsFor(uri: string): Facts | undefined {
  if (!workspaces.size) return;
  if (lookups.has(uri)) return lookups.get(uri);
  const key = uriKey(uri);
  const result = [...workspaces.values()].filter(item => key === item.root || key.startsWith(`${item.root}/`)).sort((a, b) => b.root.length - a.root.length)[0];
  if (lookups.size >= 256) lookups.clear();
  lookups.set(uri, result);
  return result;
}
function modeFor(profile: string): CustomInstructionMode { return /^P[3-7]$/.test(profile) ? profile as CustomInstructionMode : 'mars'; }
export function customInstructionFactsRevision(uri: string): number { return factsFor(uri)?.revision ?? 0; }
export function customInstructionsFor(uri: string, profile: string): readonly CustomInstructionMetadata[] { return factsFor(uri)?.registry.metadata(modeFor(profile)) ?? []; }
export function customInstructionFor(uri: string, profile: string, mnemonic: string): CustomInstructionMetadata | undefined {
  return factsFor(uri)?.registry.get(mnemonic.toLowerCase(), modeFor(profile));
}
export function customInstructionDisplay(item: CustomInstructionMetadata, mnemonic = item.mnemonic): MipsInstruction {
  const operands = item.operands.map(op => op.kind === 'register' ? `$${op.field}` : op.kind === 'memory' ? `${op.offsetField}($${op.baseField})` : op.field);
  const target = item.operands.findIndex(op => op.kind === 'immediate' && !!op.relocation);
  return { mnemonic, type: 'special', summary: '工作区自定义指令', description: `自定义编码：${item.encoding}`,
    formats: [`${mnemonic}${operands.length ? ' ' : ''}${operands.join(', ')}`], operands: [operands.length, operands.length],
    ...(target === 0 ? { labelOperand: 'first' } : target === 1 ? { labelOperand: 'second' } : target === operands.length - 1 && target >= 0 ? { labelOperand: 'last' } : {}) };
}
/** Reuse the assembler operand parser without executing a definition or resolving labels. */
export function customInstructionSyntaxIssue(uri: string, profile: string, line: string): string | undefined {
  const facts = factsFor(uri);
  if (!facts || /%[\w]+/.test(line)) return;
  const statement = parseAssemblerLine({ sourceId: uri, line: 1, text: line, startOffset: 0, endOffset: line.length, expansionStack: [] });
  if (statement.kind !== 'statement') return;
  const mode = modeFor(profile);
  const extension = customAssemblerExtension(facts.registry, mode);
  const expanded = extension.expand(statement, { compactAddresses: false, maximumInstructionsPerStatement: 1 });
  if (!expanded) return;
  if (!expanded.ok) return expanded.diagnostic?.message;
  const definition = facts.registry.get(statement.mnemonic ?? '', mode);
  // Jump-region validation needs the actual section PC; raw branch displacements do not.
  if (definition?.operands.some(op => op.kind === 'immediate' && op.relocation === 'jump')) return;
  if (!expanded.instructions?.length) return;
  const encoded = extension.encode(expanded.instructions[0], 0x3000, () => undefined);
  if (encoded?.diagnostic?.code !== 'asm.symbol.undefined') return encoded?.diagnostic?.message;
}
