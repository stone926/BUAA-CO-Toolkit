import * as path from 'path';
import * as vscode from 'vscode';
import {
  config,
  getJava,
  getMachineCode,
  getMarsJar,
  getMemoryConfiguration,
  getProfile,
  useDelayedBranching
} from './config';
import { basenameNoExt, dirname, ensureDirectory, writeTextFile } from './fsUtil';
import { runTool } from './process';
import { AppServices, ProjectProfile } from './types';

interface MipsInstruction {
  mnemonic: string;
  summary: string;
  formats: string[];
  operands: [number, number];
  description: string;
  pseudo?: boolean;
  projects?: ProjectProfile[];
  labelOperand?: 'first' | 'second' | 'last';
  delaySlot?: boolean;
}

interface MipsSymbol {
  name: string;
  kind: 'label' | 'data' | 'macro' | 'macroParam';
  range: vscode.Range;
  selectionRange: vscode.Range;
  detail?: string;
}

interface MipsMacro {
  name: string;
  params: string[];
  range: vscode.Range;
  selectionRange: vscode.Range;
  bodyStartLine: number;
  bodyEndLine?: number;
}

interface MipsLine {
  line: number;
  mnemonic: string;
  operands: string[];
  range: vscode.Range;
}

interface MipsLabelReference {
  line: number;
  operand: string;
}

interface MipsParseResult {
  labels: Map<string, MipsSymbol>;
  dataSymbols: Map<string, MipsSymbol>;
  macros: Map<string, MipsMacro>;
  macroParams: Map<string, MipsSymbol>;
  instructions: MipsLine[];
  diagnostics: vscode.Diagnostic[];
}

const registerNames = new Set([
  '$zero',
  '$at',
  '$v0',
  '$v1',
  '$a0',
  '$a1',
  '$a2',
  '$a3',
  '$t0',
  '$t1',
  '$t2',
  '$t3',
  '$t4',
  '$t5',
  '$t6',
  '$t7',
  '$s0',
  '$s1',
  '$s2',
  '$s3',
  '$s4',
  '$s5',
  '$s6',
  '$s7',
  '$t8',
  '$t9',
  '$k0',
  '$k1',
  '$gp',
  '$sp',
  '$fp',
  '$ra'
]);

const registerDescriptions = new Map<string, string>([
  ['$zero', 'Constant zero register.'],
  ['$at', 'Assembler temporary. Avoid using it directly unless you know the expansion.'],
  ['$v0', 'Return value / syscall code register.'],
  ['$v1', 'Return value register.'],
  ['$a0', 'Argument register 0.'],
  ['$a1', 'Argument register 1.'],
  ['$a2', 'Argument register 2.'],
  ['$a3', 'Argument register 3.'],
  ['$sp', 'Stack pointer.'],
  ['$ra', 'Return address register.'],
  ['$gp', 'Global pointer. Course-modified MARS may initialize it differently from standard MARS.']
]);

const directives = new Set([
  '.data',
  '.text',
  '.kdata',
  '.ktext',
  '.word',
  '.half',
  '.byte',
  '.space',
  '.ascii',
  '.asciiz',
  '.align',
  '.globl',
  '.extern',
  '.eqv',
  '.macro',
  '.end_macro',
  '.include'
]);

const instructions: Record<string, MipsInstruction> = makeInstructionMap([
  ins('add', 'Add', ['add $rd, $rs, $rt'], [3, 3], 'rd <- rs + rt. Signed overflow may trap in normal MIPS.'),
  ins('addu', 'Add unsigned', ['addu $rd, $rs, $rt'], [3, 3], 'rd <- rs + rt without signed overflow trap.'),
  ins('addi', 'Add immediate', ['addi $rt, $rs, imm'], [3, 3], 'rt <- rs + sign_extend(imm).'),
  ins('addiu', 'Add immediate unsigned', ['addiu $rt, $rs, imm'], [3, 3], 'rt <- rs + sign_extend(imm), no signed overflow trap.'),
  ins('sub', 'Subtract', ['sub $rd, $rs, $rt'], [3, 3], 'rd <- rs - rt.'),
  ins('subu', 'Subtract unsigned', ['subu $rd, $rs, $rt'], [3, 3], 'rd <- rs - rt without signed overflow trap.'),
  ins('and', 'Bitwise AND', ['and $rd, $rs, $rt'], [3, 3], 'rd <- rs & rt.'),
  ins('andi', 'Bitwise AND immediate', ['andi $rt, $rs, imm'], [3, 3], 'rt <- rs & zero_extend(imm).'),
  ins('or', 'Bitwise OR', ['or $rd, $rs, $rt'], [3, 3], 'rd <- rs | rt.'),
  ins('ori', 'Bitwise OR immediate', ['ori $rt, $rs, imm'], [3, 3], 'rt <- rs | zero_extend(imm).'),
  ins('xor', 'Bitwise XOR', ['xor $rd, $rs, $rt'], [3, 3], 'rd <- rs ^ rt.'),
  ins('xori', 'Bitwise XOR immediate', ['xori $rt, $rs, imm'], [3, 3], 'rt <- rs ^ zero_extend(imm).'),
  ins('nor', 'Bitwise NOR', ['nor $rd, $rs, $rt'], [3, 3], 'rd <- ~(rs | rt).'),
  ins('slt', 'Set less than', ['slt $rd, $rs, $rt'], [3, 3], 'rd <- signed(rs) < signed(rt).'),
  ins('sltu', 'Set less than unsigned', ['sltu $rd, $rs, $rt'], [3, 3], 'rd <- unsigned(rs) < unsigned(rt).'),
  ins('slti', 'Set less than immediate', ['slti $rt, $rs, imm'], [3, 3], 'rt <- signed(rs) < sign_extend(imm).'),
  ins('sltiu', 'Set less than immediate unsigned', ['sltiu $rt, $rs, imm'], [3, 3], 'rt <- unsigned(rs) < unsigned(sign_extend(imm)).'),
  ins('sll', 'Shift left logical', ['sll $rd, $rt, shamt'], [3, 3], 'rd <- rt << shamt.'),
  ins('srl', 'Shift right logical', ['srl $rd, $rt, shamt'], [3, 3], 'rd <- rt >> shamt with zero fill.'),
  ins('sra', 'Shift right arithmetic', ['sra $rd, $rt, shamt'], [3, 3], 'rd <- rt >> shamt with sign fill.'),
  ins('lui', 'Load upper immediate', ['lui $rt, imm'], [2, 2], 'rt <- imm << 16.'),
  ins('lw', 'Load word', ['lw $rt, offset($base)'], [2, 2], 'Load 32-bit word from memory.'),
  ins('sw', 'Store word', ['sw $rt, offset($base)'], [2, 2], 'Store 32-bit word to memory.'),
  ins('lb', 'Load byte', ['lb $rt, offset($base)'], [2, 2], 'Load signed byte.'),
  ins('lbu', 'Load byte unsigned', ['lbu $rt, offset($base)'], [2, 2], 'Load zero-extended byte.'),
  ins('lh', 'Load halfword', ['lh $rt, offset($base)'], [2, 2], 'Load signed halfword.'),
  ins('lhu', 'Load halfword unsigned', ['lhu $rt, offset($base)'], [2, 2], 'Load zero-extended halfword.'),
  ins('sb', 'Store byte', ['sb $rt, offset($base)'], [2, 2], 'Store low 8 bits to memory.'),
  ins('sh', 'Store halfword', ['sh $rt, offset($base)'], [2, 2], 'Store low 16 bits to memory.'),
  ins('beq', 'Branch if equal', ['beq $rs, $rt, label'], [3, 3], 'Branch when rs == rt.', { labelOperand: 'last', delaySlot: true }),
  ins('bne', 'Branch if not equal', ['bne $rs, $rt, label'], [3, 3], 'Branch when rs != rt.', { labelOperand: 'last', delaySlot: true }),
  ins('blez', 'Branch if less or equal zero', ['blez $rs, label'], [2, 2], 'Branch when signed(rs) <= 0.', { labelOperand: 'last', delaySlot: true }),
  ins('bgtz', 'Branch if greater than zero', ['bgtz $rs, label'], [2, 2], 'Branch when signed(rs) > 0.', { labelOperand: 'last', delaySlot: true }),
  ins('j', 'Jump', ['j label'], [1, 1], 'Jump to label.', { labelOperand: 'first', delaySlot: true }),
  ins('jal', 'Jump and link', ['jal label'], [1, 1], 'Jump to label and write return address to $ra.', { labelOperand: 'first', delaySlot: true }),
  ins('jr', 'Jump register', ['jr $rs'], [1, 1], 'Jump to address in rs.', { delaySlot: true }),
  ins('jalr', 'Jump and link register', ['jalr $rs', 'jalr $rd, $rs'], [1, 2], 'Jump to rs and write return address.'),
  ins('mult', 'Multiply signed', ['mult $rs, $rt'], [2, 2], 'Signed multiply into HI/LO.', { projects: ['P6', 'P7'] }),
  ins('multu', 'Multiply unsigned', ['multu $rs, $rt'], [2, 2], 'Unsigned multiply into HI/LO.', { projects: ['P6', 'P7'] }),
  ins('div', 'Divide signed', ['div $rs, $rt'], [2, 2], 'Signed divide into LO quotient and HI remainder.', { projects: ['P6', 'P7'] }),
  ins('divu', 'Divide unsigned', ['divu $rs, $rt'], [2, 2], 'Unsigned divide into LO quotient and HI remainder.', { projects: ['P6', 'P7'] }),
  ins('mfhi', 'Move from HI', ['mfhi $rd'], [1, 1], 'rd <- HI.', { projects: ['P6', 'P7'] }),
  ins('mflo', 'Move from LO', ['mflo $rd'], [1, 1], 'rd <- LO.', { projects: ['P6', 'P7'] }),
  ins('mthi', 'Move to HI', ['mthi $rs'], [1, 1], 'HI <- rs.', { projects: ['P6', 'P7'] }),
  ins('mtlo', 'Move to LO', ['mtlo $rs'], [1, 1], 'LO <- rs.', { projects: ['P6', 'P7'] }),
  ins('mfc0', 'Move from CP0', ['mfc0 $rt, $rd'], [2, 2], 'rt <- CP0[rd].', { projects: ['P7'] }),
  ins('mtc0', 'Move to CP0', ['mtc0 $rt, $rd'], [2, 2], 'CP0[rd] <- rt.', { projects: ['P7'] }),
  ins('eret', 'Exception return', ['eret'], [0, 0], 'Return from exception. In BUAA CO P7, eret has no delay slot.', { projects: ['P7'] }),
  ins('syscall', 'System call / exception', ['syscall'], [0, 0], 'Invokes a MARS syscall in P2 or raises syscall exception in P7.'),
  ins('nop', 'No operation', ['nop'], [0, 0], 'Expands to sll $zero, $zero, 0.'),
  ins('li', 'Load immediate', ['li $rt, imm'], [2, 2], 'Pseudo instruction for loading an immediate.', { pseudo: true }),
  ins('la', 'Load address', ['la $rt, label'], [2, 2], 'Pseudo instruction for loading an address.', { pseudo: true, labelOperand: 'second' }),
  ins('move', 'Move register', ['move $rd, $rs'], [2, 2], 'Pseudo instruction, usually addu $rd, $rs, $zero.', { pseudo: true }),
  ins('blt', 'Branch less than', ['blt $rs, $rt, label'], [3, 3], 'Pseudo branch.', { pseudo: true, labelOperand: 'last', delaySlot: true }),
  ins('bgt', 'Branch greater than', ['bgt $rs, $rt, label'], [3, 3], 'Pseudo branch.', { pseudo: true, labelOperand: 'last', delaySlot: true }),
  ins('ble', 'Branch less or equal', ['ble $rs, $rt, label'], [3, 3], 'Pseudo branch.', { pseudo: true, labelOperand: 'last', delaySlot: true }),
  ins('bge', 'Branch greater or equal', ['bge $rs, $rt, label'], [3, 3], 'Pseudo branch.', { pseudo: true, labelOperand: 'last', delaySlot: true })
]);

export function registerMips(context: vscode.ExtensionContext, services: AppServices): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('buaa-co-mips');
  context.subscriptions.push(diagnostics);

  const refresh = (document: vscode.TextDocument) => {
    if (document.languageId === 'mipsasm') {
      diagnostics.set(document.uri, parseMips(document).diagnostics);
    }
  };

  for (const document of vscode.workspace.textDocuments) {
    refresh(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((event) => refresh(event.document)),
    vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    vscode.languages.registerCompletionItemProvider({ language: 'mipsasm' }, new MipsCompletionProvider(), '$', '.', '%'),
    vscode.languages.registerHoverProvider({ language: 'mipsasm' }, new MipsHoverProvider()),
    vscode.languages.registerDefinitionProvider({ language: 'mipsasm' }, new MipsDefinitionProvider()),
    vscode.languages.registerDocumentSymbolProvider({ language: 'mipsasm' }, new MipsDocumentSymbolProvider()),
    vscode.languages.registerDocumentFormattingEditProvider({ language: 'mipsasm' }, new MipsFormatter()),
    vscode.commands.registerCommand('co.mips.runCurrentFile', () => runMarsCurrentFile(services, 'run')),
    vscode.commands.registerCommand('co.mips.dumpText', () => runMarsCurrentFile(services, 'dumpText')),
    vscode.commands.registerCommand('co.mips.dumpKernelText', () => runMarsCurrentFile(services, 'dumpKernel'))
  );
}

class MipsCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
    const parsed = parseMips(document);
    const linePrefix = document.lineAt(position).text.slice(0, position.character);
    const items: vscode.CompletionItem[] = [];

    if (/\$[\w]*$/.test(linePrefix)) {
      for (const name of [...registerNames, ...numericRegisters()]) {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
        item.detail = registerDescriptions.get(name) ?? 'MIPS register';
        items.push(item);
      }
      return items;
    }

    if (/%[\w]*$/.test(linePrefix)) {
      for (const symbol of parsed.macroParams.values()) {
        const item = new vscode.CompletionItem(symbol.name, vscode.CompletionItemKind.Variable);
        item.detail = 'Macro parameter';
        items.push(item);
      }
      return items;
    }

    for (const instruction of Object.values(instructions)) {
      const item = new vscode.CompletionItem(instruction.mnemonic, vscode.CompletionItemKind.Keyword);
      item.detail = instruction.summary;
      item.documentation = new vscode.MarkdownString(instruction.formats.join('\n\n'));
      item.insertText = instruction.mnemonic;
      items.push(item);
    }

    for (const directive of directives) {
      items.push(new vscode.CompletionItem(directive, vscode.CompletionItemKind.Keyword));
    }

    for (const symbol of [...parsed.labels.values(), ...parsed.dataSymbols.values()]) {
      const item = new vscode.CompletionItem(symbol.name, vscode.CompletionItemKind.Reference);
      item.detail = symbol.kind === 'data' ? 'Data symbol' : 'Label';
      items.push(item);
    }

    for (const macro of parsed.macros.values()) {
      const item = new vscode.CompletionItem(macro.name, vscode.CompletionItemKind.Function);
      item.detail = `Macro(${macro.params.join(', ')})`;
      item.insertText = `${macro.name}(${macro.params.map((param, index) => `\${${index + 1}:${param}}`).join(', ')})`;
      item.insertText = new vscode.SnippetString(item.insertText as string);
      items.push(item);
    }

    return items;
  }
}

class MipsHoverProvider implements vscode.HoverProvider {
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    const wordRange = getMipsWordRange(document, position);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const parsed = parseMips(document);
    const instruction = instructions[word.toLowerCase()];
    if (instruction) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${instruction.mnemonic}** - ${instruction.summary}\n\n`);
      md.appendCodeblock(instruction.formats.join('\n'), 'mipsasm');
      md.appendMarkdown(`\n${instruction.description}`);
      if (instruction.pseudo) {
        md.appendMarkdown('\n\nPseudo instruction. Check generated code before using it in restricted projects.');
      }
      if (instruction.delaySlot) {
        md.appendMarkdown('\n\nControl-transfer instruction. Delay-slot behavior depends on the current project/profile.');
      }
      return new vscode.Hover(md, wordRange);
    }

    if (isRegister(word)) {
      const canonical = canonicalRegister(word);
      return new vscode.Hover(registerDescriptions.get(canonical) ?? `MIPS register ${word}`, wordRange);
    }

    const symbol = parsed.labels.get(word) ?? parsed.dataSymbols.get(word);
    if (symbol) {
      return new vscode.Hover(`${symbol.kind === 'data' ? 'Data symbol' : 'Label'} defined on line ${symbol.range.start.line + 1}.`, wordRange);
    }

    const macro = parsed.macros.get(word);
    if (macro) {
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**Macro** \`${macro.name}(${macro.params.join(', ')})\`\n\n`);
      md.appendCodeblock(macroBody(document, macro), 'mipsasm');
      return new vscode.Hover(md, wordRange);
    }

    return undefined;
  }
}

class MipsDefinitionProvider implements vscode.DefinitionProvider {
  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.Definition | undefined {
    const wordRange = getMipsWordRange(document, position);
    if (!wordRange) {
      return undefined;
    }
    const word = document.getText(wordRange);
    const parsed = parseMips(document);
    const symbol = parsed.labels.get(word) ?? parsed.dataSymbols.get(word);
    if (symbol) {
      return new vscode.Location(document.uri, symbol.selectionRange);
    }
    const macro = parsed.macros.get(word);
    if (macro) {
      return new vscode.Location(document.uri, macro.selectionRange);
    }
    const param = parsed.macroParams.get(word);
    if (param) {
      return new vscode.Location(document.uri, param.selectionRange);
    }
    return undefined;
  }
}

class MipsDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const parsed = parseMips(document);
    const symbols: vscode.DocumentSymbol[] = [];
    for (const symbol of [...parsed.labels.values(), ...parsed.dataSymbols.values()]) {
      const kind = symbol.kind === 'data' ? vscode.SymbolKind.Variable : vscode.SymbolKind.Function;
      symbols.push(new vscode.DocumentSymbol(symbol.name, symbol.kind, kind, symbol.range, symbol.selectionRange));
    }
    for (const macro of parsed.macros.values()) {
      symbols.push(new vscode.DocumentSymbol(macro.name, `macro(${macro.params.join(', ')})`, vscode.SymbolKind.Function, macro.range, macro.selectionRange));
    }
    return symbols.sort((a, b) => a.range.start.line - b.range.start.line);
  }
}

class MipsFormatter implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(document: vscode.TextDocument): vscode.TextEdit[] {
    const edits: vscode.TextEdit[] = [];
    for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
      const line = document.lineAt(lineNumber);
      const formatted = formatMipsLine(line.text);
      if (formatted !== line.text) {
        edits.push(vscode.TextEdit.replace(line.range, formatted));
      }
    }
    return edits;
  }
}

export function parseMips(document: vscode.TextDocument): MipsParseResult {
  const labels = new Map<string, MipsSymbol>();
  const dataSymbols = new Map<string, MipsSymbol>();
  const macros = new Map<string, MipsMacro>();
  const macroParams = new Map<string, MipsSymbol>();
  const instructionsSeen: MipsLine[] = [];
  const labelReferences: MipsLabelReference[] = [];
  const diagnostics: vscode.Diagnostic[] = [];
  const profile = getProfile(document.uri);
  let section: 'text' | 'data' | 'other' = 'text';
  let activeMacro: MipsMacro | undefined;
  let hasSyscall = false;

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const original = document.lineAt(lineNumber).text;
    let code = stripComment(original);
    let scanOffset = 0;

    while (true) {
      const labelMatch = code.match(/^\s*([A-Za-z_.$][\w.$]*):/);
      if (!labelMatch) {
        break;
      }
      const name = labelMatch[1];
      const start = original.indexOf(name, scanOffset);
      const selectionRange = new vscode.Range(lineNumber, start, lineNumber, start + name.length);
      const symbol: MipsSymbol = {
        name,
        kind: section === 'data' ? 'data' : 'label',
        range: document.lineAt(lineNumber).range,
        selectionRange
      };
      const targetMap = section === 'data' ? dataSymbols : labels;
      if (targetMap.has(name) || labels.has(name) || dataSymbols.has(name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate symbol '${name}'.`, vscode.DiagnosticSeverity.Error, 'duplicate-symbol'));
      } else {
        targetMap.set(name, symbol);
      }
      const consumed = labelMatch[0].length;
      code = code.slice(consumed);
      scanOffset += consumed;
    }

    const trimmed = code.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith('.data')) {
      section = 'data';
    } else if (trimmed.startsWith('.text') || trimmed.startsWith('.ktext')) {
      section = 'text';
    } else if (trimmed.startsWith('.kdata')) {
      section = 'data';
    }

    const macroStart = trimmed.match(/^\.macro\s+([A-Za-z_.$][\w.$]*)(.*)$/);
    if (macroStart) {
      const name = macroStart[1];
      const nameStart = original.indexOf(name);
      const params = macroStart[2]
        .trim()
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => (item.startsWith('%') ? item : `%${item}`));
      const selectionRange = new vscode.Range(lineNumber, nameStart, lineNumber, nameStart + name.length);
      const macro: MipsMacro = {
        name,
        params,
        range: document.lineAt(lineNumber).range,
        selectionRange,
        bodyStartLine: lineNumber + 1
      };
      if (activeMacro) {
        diagnostics.push(makeDiagnostic(selectionRange, `Nested macro '${name}' is not supported by this language service.`, vscode.DiagnosticSeverity.Warning, 'nested-macro'));
      }
      if (macros.has(name)) {
        diagnostics.push(makeDiagnostic(selectionRange, `Duplicate macro '${name}'.`, vscode.DiagnosticSeverity.Error, 'duplicate-macro'));
      } else {
        macros.set(name, macro);
      }
      activeMacro = macro;
      for (const param of params) {
        const paramIndex = original.indexOf(param);
        if (paramIndex >= 0) {
          macroParams.set(param, {
            name: param,
            kind: 'macroParam',
            range: document.lineAt(lineNumber).range,
            selectionRange: new vscode.Range(lineNumber, paramIndex, lineNumber, paramIndex + param.length)
          });
        }
      }
      continue;
    }

    if (trimmed.startsWith('.end_macro')) {
      if (!activeMacro) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, '.end_macro'), 'Unexpected .end_macro without a matching .macro.', vscode.DiagnosticSeverity.Error, 'macro-end'));
      } else {
        activeMacro.bodyEndLine = lineNumber - 1;
        activeMacro.range = new vscode.Range(activeMacro.range.start, document.lineAt(lineNumber).range.end);
        activeMacro = undefined;
      }
      continue;
    }

    validateRegisters(document, lineNumber, original, diagnostics);

    const firstToken = trimmed.match(/^([A-Za-z_.$][\w.$]*|\.[A-Za-z_][\w.]*)/);
    if (!firstToken) {
      continue;
    }
    const mnemonic = firstToken[1].toLowerCase();
    if (mnemonic.startsWith('.')) {
      if (!directives.has(mnemonic)) {
        diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown directive '${firstToken[1]}'.`, vscode.DiagnosticSeverity.Warning, 'unknown-directive'));
      }
      continue;
    }

    const instruction = instructions[mnemonic];
    const macro = macros.get(firstToken[1]);
    if (!instruction && !macro) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, lineNumber, firstToken[1]), `Unknown instruction or macro '${firstToken[1]}'.`, vscode.DiagnosticSeverity.Warning, 'unknown-instruction'));
      continue;
    }

    if (instruction) {
      if (mnemonic === 'syscall') {
        hasSyscall = true;
      }
      const operandText = trimmed.slice(firstToken[0].length).trim();
      const operands = parseOperands(operandText);
      instructionsSeen.push({
        line: lineNumber,
        mnemonic,
        operands,
        range: rangeOfText(document, lineNumber, firstToken[1])
      });
      validateInstruction(document, lineNumber, instruction, operands, profile, diagnostics);
      const labelRef = labelOperand(instruction, operands);
      if (labelRef && isSymbolLike(labelRef)) {
        labelReferences.push({
          line: lineNumber,
          operand: labelRef
        });
      }
    }
  }

  if (activeMacro) {
    diagnostics.push(makeDiagnostic(activeMacro.selectionRange, `Macro '${activeMacro.name}' is missing .end_macro.`, vscode.DiagnosticSeverity.Error, 'macro-unclosed'));
  }

  for (const reference of labelReferences) {
    if (!labels.has(reference.operand) && !dataSymbols.has(reference.operand)) {
      diagnostics.push(makeDiagnostic(rangeOfText(document, reference.line, reference.operand), `Cannot find label or data symbol '${reference.operand}'.`, vscode.DiagnosticSeverity.Error, 'missing-label'));
    }
  }

  if (profile === 'P2' && config<boolean>('mips.warnMissingExitSyscall', true, document.uri) && !hasSyscall && document.lineCount > 2) {
    const range = new vscode.Range(0, 0, 0, Math.max(1, document.lineAt(0).text.length));
    diagnostics.push(makeDiagnostic(range, 'P2 programs usually need a syscall exit path, otherwise MARS/online tests may time out.', vscode.DiagnosticSeverity.Warning, 'missing-syscall'));
  }

  return {
    labels,
    dataSymbols,
    macros,
    macroParams,
    instructions: instructionsSeen,
    diagnostics
  };
}

async function runMarsCurrentFile(services: AppServices, mode: 'run' | 'dumpText' | 'dumpKernel'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'mipsasm') {
    vscode.window.showErrorMessage('Open a MIPS ASM file first.');
    return;
  }
  const document = editor.document;
  if (document.isUntitled) {
    vscode.window.showErrorMessage('Save the ASM file before running MARS.');
    return;
  }
  if (document.isDirty) {
    await document.save();
  }

  const mars = getMarsJar(document.uri);
  if (!mars) {
    vscode.window.showErrorMessage('MARS jar is not configured. Set co.toolchain.mars or co.toolchain.marsP7.');
    return;
  }

  services.output.show(true);
  const java = getJava(document.uri);
  const cwd = dirname(document.uri);
  const asm = document.uri.fsPath;
  const args = ['-jar', mars, 'nc', 'mc', getMemoryConfiguration(document.uri)];
  if (useDelayedBranching(document.uri)) {
    args.push('db');
  }

  if (mode === 'dumpText') {
    args.push('a', 'dump', '.text', 'HexText', path.join(cwd, getMachineCode(document.uri)), asm);
  } else if (mode === 'dumpKernel') {
    args.push('a', 'dump', '0x00004180-0x00004ffc', 'HexText', path.join(cwd, `${basenameNoExt(document.uri)}.kernel.txt`), asm);
  } else {
    args.push(asm);
  }

  const result = await runTool(java, args, {
    cwd,
    output: services.output,
    resource: document.uri
  });

  if (mode === 'run') {
    const outDir = vscode.Uri.file(path.join(cwd, '.co', 'out'));
    await ensureDirectory(outDir);
    const outFile = vscode.Uri.file(path.join(outDir.fsPath, `${basenameNoExt(document.uri)}.mars.out`));
    await writeTextFile(outFile, result.stdout);
  }

  if (result.ok) {
    if (mode === 'dumpText') {
      vscode.window.showInformationMessage(`MARS dumped ${getMachineCode(document.uri)}.`);
    } else if (mode === 'dumpKernel') {
      vscode.window.showInformationMessage('MARS dumped kernel text segment.');
    } else {
      vscode.window.showInformationMessage('MARS run completed.');
    }
  } else {
    vscode.window.showErrorMessage(`MARS failed${result.exitCode === null ? '' : ` with exit code ${result.exitCode}`}.`);
  }
}

function validateInstruction(
  document: vscode.TextDocument,
  lineNumber: number,
  instruction: MipsInstruction,
  operands: string[],
  profile: ProjectProfile,
  diagnostics: vscode.Diagnostic[]
): void {
  const [min, max] = instruction.operands;
  if (operands.length < min || operands.length > max) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} expects ${min === max ? min : `${min}-${max}`} operand(s), got ${operands.length}.`,
        vscode.DiagnosticSeverity.Error,
        'operand-count'
      )
    );
  }

  if (instruction.pseudo && config<boolean>('mips.warnPseudoInstruction', true, document.uri)) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} is a pseudo instruction. Verify expansion when generating CPU tests.`,
        vscode.DiagnosticSeverity.Information,
        'pseudo-instruction'
      )
    );
  }

  if (profile !== 'auto' && instruction.projects && !instruction.projects.includes(profile)) {
    diagnostics.push(
      makeDiagnostic(
        rangeOfText(document, lineNumber, instruction.mnemonic),
        `${instruction.mnemonic} is normally used in ${instruction.projects.join('/')} profile(s), not ${profile}.`,
        vscode.DiagnosticSeverity.Warning,
        'project-instruction'
      )
    );
  }
}

function validateRegisters(document: vscode.TextDocument, lineNumber: number, line: string, diagnostics: vscode.Diagnostic[]): void {
  const code = stripComment(line);
  const regex = /\$[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    const reg = match[0];
    if (!isRegister(reg)) {
      diagnostics.push(makeDiagnostic(new vscode.Range(lineNumber, match.index, lineNumber, match.index + reg.length), `Unknown register '${reg}'.`, vscode.DiagnosticSeverity.Error, 'unknown-register'));
    }
  }
}

function stripComment(line: string): string {
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') {
      inString = !inString;
    }
    if (char === '#' && !inString) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseOperands(text: string): string[] {
  if (!text) {
    return [];
  }
  const normalized = text.trim().replace(/^\(/, '').replace(/\)$/, '');
  if (!normalized) {
    return [];
  }
  return normalized
    .split(',')
    .map((operand) => operand.trim())
    .filter(Boolean);
}

function labelOperand(instruction: MipsInstruction, operands: string[]): string | undefined {
  if (instruction.labelOperand === 'first') {
    return operands[0];
  }
  if (instruction.labelOperand === 'second') {
    return operands[1];
  }
  if (instruction.labelOperand === 'last') {
    return operands[operands.length - 1];
  }
  return undefined;
}

function isSymbolLike(value: string): boolean {
  return /^[A-Za-z_.$][\w.$]*$/.test(value);
}

function isRegister(value: string): boolean {
  const canonical = canonicalRegister(value);
  return registerNames.has(canonical) || /^\$(?:[0-9]|[12][0-9]|3[01])$/.test(value);
}

function canonicalRegister(value: string): string {
  if (/^\$(?:[0-9]|[12][0-9]|3[01])$/.test(value)) {
    const number = Number(value.slice(1));
    const names = [
      '$zero',
      '$at',
      '$v0',
      '$v1',
      '$a0',
      '$a1',
      '$a2',
      '$a3',
      '$t0',
      '$t1',
      '$t2',
      '$t3',
      '$t4',
      '$t5',
      '$t6',
      '$t7',
      '$s0',
      '$s1',
      '$s2',
      '$s3',
      '$s4',
      '$s5',
      '$s6',
      '$s7',
      '$t8',
      '$t9',
      '$k0',
      '$k1',
      '$gp',
      '$sp',
      '$fp',
      '$ra'
    ];
    return names[number] ?? value;
  }
  return value.toLowerCase();
}

function numericRegisters(): string[] {
  return Array.from({ length: 32 }, (_, index) => `$${index}`);
}

function makeInstructionMap(list: MipsInstruction[]): Record<string, MipsInstruction> {
  const map: Record<string, MipsInstruction> = {};
  for (const item of list) {
    map[item.mnemonic] = item;
  }
  return map;
}

function ins(
  mnemonic: string,
  summary: string,
  formats: string[],
  operands: [number, number],
  description: string,
  options: Partial<MipsInstruction> = {}
): MipsInstruction {
  return {
    mnemonic,
    summary,
    formats,
    operands,
    description,
    ...options
  };
}

function makeDiagnostic(range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity, code: string): vscode.Diagnostic {
  const diagnostic = new vscode.Diagnostic(range, message, severity);
  diagnostic.source = 'BUAA CO';
  diagnostic.code = code;
  return diagnostic;
}

function rangeOfText(document: vscode.TextDocument, lineNumber: number, text: string): vscode.Range {
  const line = document.lineAt(lineNumber).text;
  const start = Math.max(0, line.indexOf(text));
  return new vscode.Range(lineNumber, start, lineNumber, start + text.length);
}

function getMipsWordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
  return document.getWordRangeAtPosition(position, /[%$]?[A-Za-z_.$0-9][\w.$]*/);
}

function macroBody(document: vscode.TextDocument, macro: MipsMacro): string {
  if (macro.bodyEndLine === undefined || macro.bodyEndLine < macro.bodyStartLine) {
    return '';
  }
  const lines: string[] = [];
  for (let line = macro.bodyStartLine; line <= macro.bodyEndLine; line++) {
    lines.push(document.lineAt(line).text);
  }
  return lines.join('\n');
}

function formatMipsLine(line: string): string {
  const commentIndex = findCommentIndex(line);
  const code = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const comment = commentIndex >= 0 ? line.slice(commentIndex).trimEnd() : '';
  if (!code.trim()) {
    return comment ? comment : '';
  }
  const trimmed = code.trim().replace(/\s*,\s*/g, ', ');
  const formattedCode = /^[A-Za-z_.$][\w.$]*:/.test(trimmed) || trimmed.startsWith('.') ? trimmed : `    ${trimmed}`;
  if (!comment) {
    return formattedCode;
  }
  return `${formattedCode.padEnd(Math.max(formattedCode.length + 1, 32))}${comment}`;
}

function findCommentIndex(line: string): number {
  let inString = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"' && line[index - 1] !== '\\') {
      inString = !inString;
    }
    if (char === '#' && !inString) {
      return index;
    }
  }
  return -1;
}
