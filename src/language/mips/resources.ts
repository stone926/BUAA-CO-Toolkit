import * as fs from 'fs';
import * as path from 'path';
import { DocumentUri } from 'vscode-languageserver/node';
import { CoSettings } from '../common/settings';

export interface MipsInstruction {
  mnemonic: string;
  summary: string;
  type: MipsInstructionType;
  formats: string[];
  operands: [number, number];
  description: string;
  pseudo?: boolean;
  projects?: string[];
  labelOperand?: 'first' | 'second' | 'last';
  delaySlot?: boolean;
}

export type MipsInstructionType = 'R-type' | 'I-type' | 'J-type' | 'special' | 'pseudo';

interface MipsRegisterInfo {
  number: number;
  names: string[];
  usage: string;
}

interface MipsResourceData {
  registers: MipsRegisterInfo[];
  directives: string[];
  instructions: MipsInstruction[];
}

export const mipsSemanticTokenTypes = [
  'mipsDirective',
  'mipsInstruction',
  'mipsRealInstruction',
  'mipsRInstruction',
  'mipsIInstruction',
  'mipsJInstruction',
  'mipsSpecialInstruction',
  'mipsPseudoInstruction',
  'mipsRegister',
  'mipsMacro',
  'mipsMacroParameter',
  'mipsLabel',
  'mipsDataSymbol',
  'mipsEqvSymbol',
  'mipsNumber',
  'mipsString',
  'mipsComment',
  'mipsPunctuation'
] as const;

export type MipsSemanticTokenType = typeof mipsSemanticTokenTypes[number];
export type MipsInstructionColorMode = CoSettings['mips']['instructionColorMode'];

const mipsResourceData = loadMipsResourceData();
const registerInfos = mipsResourceData.registers;
const registerByNumber = new Map(registerInfos.map((info) => [info.number, info]));
const registerAliases = new Map(registerInfos.flatMap((info) => info.names.map((name) => [name.toLowerCase(), info.names[0].toLowerCase()] as const)));

export const registerNames = new Set(registerInfos.flatMap((info) => info.names.map((name) => name.toLowerCase())));
export const registerDescriptions = new Map<string, string>();
export const directives = new Set(mipsResourceData.directives);
export const instructions: Record<string, MipsInstruction> = makeInstructionMap(mipsResourceData.instructions);

for (const info of registerInfos) {
  const names = info.names.join(' / ');
  const description = '$' + info.number + ' (' + names + '): ' + info.usage;
  registerDescriptions.set('$' + info.number, description);
  for (const name of info.names) {
    registerDescriptions.set(name.toLowerCase(), description);
  }
}

export function isRegister(value: string): boolean {
  const canonical = canonicalRegister(value);
  return registerNames.has(canonical) || /^\$(?:[0-9]|[12][0-9]|3[01])$/.test(value);
}

export function canonicalRegister(value: string): string {
  if (/^\$(?:[0-9]|[12][0-9]|3[01])$/.test(value)) {
    const number = Number(value.slice(1));
    return registerByNumber.get(number)?.names[0].toLowerCase() ?? value;
  }
  const lower = value.toLowerCase();
  return registerAliases.get(lower) ?? lower;
}

export function numericRegisters(): string[] {
  return Array.from({ length: 32 }, (_, index) => `$${index}`);
}

export function instructionTypeLabel(type: MipsInstructionType): string {
  switch (type) {
    case 'R-type':
      return 'R 型指令';
    case 'I-type':
      return 'I 型指令';
    case 'J-type':
      return 'J 型指令';
    case 'special':
      return '特殊指令';
    case 'pseudo':
      return '伪指令';
  }
}

export function instructionSemanticTokenType(instruction: MipsInstruction, settings: CoSettings): MipsSemanticTokenType {
  const colorMode = settings.mips.instructionColorMode;
  if (colorMode === 'same') {
    return 'mipsInstruction';
  }
  if (colorMode === 'realVsPseudo') {
    return instruction.type === 'pseudo' ? 'mipsPseudoInstruction' : 'mipsRealInstruction';
  }

  switch (instruction.type) {
    case 'R-type':
      return 'mipsRInstruction';
    case 'I-type':
      return 'mipsIInstruction';
    case 'J-type':
      return 'mipsJInstruction';
    case 'special':
      return 'mipsSpecialInstruction';
    case 'pseudo':
      return 'mipsPseudoInstruction';
  }
}

export function shouldWarnPseudoInstruction(settings: CoSettings, uri: DocumentUri, mnemonic: string, ignoredFiles: Set<string>, ignoredMnemonics: Set<string>): boolean {
  return (
    settings.mips.warnPseudoInstruction &&
    !ignoredFiles.has(uri) &&
    !ignoredMnemonics.has(mnemonic.toLowerCase())
  );
}

function loadMipsResourceData(): MipsResourceData {
  const resourceRoot = path.join(__dirname, '..', '..', '..', 'resources', 'mips');
  const registers = readJsonResource<MipsRegisterInfo[]>(path.join(resourceRoot, 'registers.json'));
  const directiveList = readJsonResource<string[]>(path.join(resourceRoot, 'directives.json')).map((directive) => directive.toLowerCase());
  const loadedInstructions = readJsonResource<MipsInstruction[]>(path.join(resourceRoot, 'instructions.json'));
  const instructionList = loadedInstructions.map((instruction) => ({
    ...instruction,
    mnemonic: instruction.mnemonic.toLowerCase(),
    operands: normalizeOperandRange(instruction.operands)
  }));

  validateMipsResources(registers, directiveList, instructionList);
  return {
    registers,
    directives: directiveList,
    instructions: instructionList
  };
}

function readJsonResource<T>(file: string): T {
  const content = fs.readFileSync(file, 'utf8');
  return JSON.parse(content) as T;
}

function normalizeOperandRange(value: unknown): [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'number' || typeof value[1] !== 'number') {
    throw new Error('Invalid MIPS instruction operand range in resources.');
  }
  return [value[0], value[1]];
}

function validateMipsResources(registers: MipsRegisterInfo[], directiveList: string[], instructionList: MipsInstruction[]): void {
  if (!Array.isArray(registers) || registers.length !== 32) {
    throw new Error('MIPS register resource must contain 32 registers.');
  }
  for (const register of registers) {
    if (!Number.isInteger(register.number) || register.number < 0 || register.number > 31 || !Array.isArray(register.names) || register.names.length === 0) {
      throw new Error('Invalid MIPS register resource entry.');
    }
  }

  if (!Array.isArray(directiveList) || directiveList.some((directive) => typeof directive !== 'string' || !directive.startsWith('.'))) {
    throw new Error('Invalid MIPS directive resource.');
  }

  const seen = new Set<string>();
  for (const instruction of instructionList) {
    if (!instruction.mnemonic || seen.has(instruction.mnemonic) || !Array.isArray(instruction.formats) || !isMipsInstructionType(instruction.type)) {
      throw new Error('Invalid or duplicate MIPS instruction resource entry.');
    }
    normalizeOperandRange(instruction.operands);
    seen.add(instruction.mnemonic);
  }
}

function isMipsInstructionType(value: unknown): value is MipsInstructionType {
  return value === 'R-type' || value === 'I-type' || value === 'J-type' || value === 'special' || value === 'pseudo';
}

function makeInstructionMap(list: MipsInstruction[]): Record<string, MipsInstruction> {
  const map: Record<string, MipsInstruction> = {};
  for (const item of list) {
    map[item.mnemonic] = item;
  }
  return map;
}
