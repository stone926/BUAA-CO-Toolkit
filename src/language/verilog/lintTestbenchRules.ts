import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { makeDiagnostic } from '../common/lsp';
import { CoSettings } from '../common/settings';
import {
  collectProceduralBlocksFromCst,
  VerilogProceduralBlockAst
} from './blockAst';
import { VerilogCstDocument } from './cst';
import { VerilogToken } from './lexer';
import { VerilogModule } from './model';
import { isClockSignalName } from './lintSignalNames';

export function collectTestbenchDiagnostics(
  document: TextDocument,
  settings: CoSettings,
  text: string,
  modules: VerilogModule[],
  cst: VerilogCstDocument,
  diagnostics: Diagnostic[]
): void {
  for (const module of modules) {
    if (!isTestbenchModule(module, settings)) {
      continue;
    }
    const bodyStart = document.offsetAt(module.headerEnd);
    const bodyEnd = document.offsetAt(module.range.end);
    const body = text.slice(bodyStart, bodyEnd);
    const proceduralBlocks = collectProceduralBlocksFromCst(document, cst, module);
    if (!/`timescale\s+1ns\s*\/\s*1ps/.test(text)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: standard course testbenches should use `timescale 1ns / 1ps.', DiagnosticSeverity.Information, 'tb-timescale'));
    }
    if (!hasTestbenchClockGeneration(module, proceduralBlocks)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: include clk generation logic.', DiagnosticSeverity.Information, 'tb-clock'));
    }
    if (!/\breset\b/.test(body)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: include reset generation logic.', DiagnosticSeverity.Information, 'tb-reset'));
    }
    if (!/\$readmemh\s*\(\s*"code\.txt"/.test(body)) {
      diagnostics.push(makeDiagnostic(module.selectionRange, 'Testbench: use $readmemh("code.txt", im) to load machine code when simulating CPU projects.', DiagnosticSeverity.Information, 'tb-readmemh'));
    }
  }
}

export function isTestbenchModule(module: VerilogModule, settings: CoSettings): boolean {
  const configured = settings.project.testbench.trim().toLowerCase();
  const name = module.name.toLowerCase();
  return name.includes('tb') || (configured !== '' && name === configured);
}

function hasTestbenchClockGeneration(module: VerilogModule, blocks: VerilogProceduralBlockAst[]): boolean {
  const clockNames = declaredClockNames(module);
  if (!clockNames.size) {
    return false;
  }
  for (const block of blocks) {
    if (block.kind === 'always') {
      if (block.controlKind === 'event') {
        continue;
      }
      if (block.controlKind === 'delay' && findClockToggleAssignment(block.bodyTokens, clockNames) >= 0) {
        return true;
      }
      if (block.controlKind === 'none' && hasDelayBeforeClockToggle(block.bodyTokens, clockNames)) {
        return true;
      }
      continue;
    }
    if (block.kind === 'initial' && hasForeverDelayClockToggle(block.bodyTokens, clockNames)) {
      return true;
    }
  }
  return false;
}

function declaredClockNames(module: VerilogModule): Set<string> {
  return new Set([...module.declarations.keys()].filter(isClockSignalName));
}

function hasForeverDelayClockToggle(tokens: VerilogToken[], clockNames: Set<string>): boolean {
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].value !== 'forever') {
      continue;
    }
    const end = proceduralStatementWindowEnd(tokens, index + 1);
    if (end <= index) {
      continue;
    }
    if (hasDelayBeforeClockToggle(tokens.slice(index, end + 1), clockNames)) {
      return true;
    }
  }
  return false;
}

function hasDelayBeforeClockToggle(tokens: VerilogToken[], clockNames: Set<string>): boolean {
  const assignmentIndex = findClockToggleAssignment(tokens, clockNames);
  if (assignmentIndex < 0) {
    return false;
  }
  const prefix = tokens.slice(0, assignmentIndex);
  return prefix.some((token) => token.value === '#') && !prefix.some((token) => token.value === '@' || token.value === 'wait');
}

function findClockToggleAssignment(tokens: VerilogToken[], clockNames: Set<string>): number {
  for (let index = 0; index <= tokens.length - 4; index++) {
    const target = tokens[index];
    if (target.kind !== 'identifier' || !clockNames.has(target.value)) {
      continue;
    }
    const operator = tokens[index + 1];
    const inverter = tokens[index + 2];
    const source = tokens[index + 3];
    if (
      (operator.value === '=' || operator.value === '<=') &&
      (inverter.value === '~' || inverter.value === '!') &&
      source.kind === 'identifier' &&
      source.value === target.value
    ) {
      return index;
    }
  }
  return -1;
}

function proceduralStatementWindowEnd(tokens: VerilogToken[], start: number): number {
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].value === 'begin') {
      const end = findMatchingBeginEndToken(tokens, index);
      return end >= 0 ? end : index;
    }
    if (tokens[index].value === ';') {
      return index;
    }
  }
  return tokens.length - 1;
}

function findMatchingBeginEndToken(tokens: VerilogToken[], beginIndex: number): number {
  let depth = 0;
  for (let index = beginIndex; index < tokens.length; index++) {
    if (tokens[index].value === 'begin') {
      depth++;
    } else if (tokens[index].value === 'end') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}
