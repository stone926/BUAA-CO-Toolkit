// @index resources — ISA静态资源：指令/寄存器/CP0/syscall加载
import * as fs from 'fs';
import * as path from 'path';
import { DocumentUri } from 'vscode-languageserver/node';
import { CoSettings } from '../common/settings';
import {
  IsaDisplayInstructionFact,
  isaDisplayInstructionByMnemonic,
  isaDisplayInstructions
} from './generated/isaDisplayCatalog';

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
  /** Versioned structural facts generated from resources/mips/isa.json. */
  isa?: IsaDisplayInstructionFact;
}

export type MipsInstructionType = 'R-type' | 'I-type' | 'J-type' | 'special' | 'pseudo';

interface MipsRegisterInfo {
  number: number;
  names: string[];
  usage: string;
}

export interface MipsSyscallInfo {
  code: number;
  name: string;
  parameters?: string;
  returns?: string;
  description: string;
}

export interface MipsCp0FieldInfo {
  name: string;
  bits: string;
  description: string;
}

export interface MipsExceptionCodeInfo {
  code: number;
  name: string;
  description: string;
}

export interface MipsCp0RegisterInfo {
  number: number;
  name: string;
  alias?: string;
  courseRequired?: boolean;
  writableByTest?: boolean;
  description: string;
  fields?: MipsCp0FieldInfo[];
  excCodes?: MipsExceptionCodeInfo[];
  notes?: string[];
}

interface MipsPseudoFormData {
  registerRegisterImmediate: string[];
  bitwiseImmediate: string[];
  signedImmediateExpansion: string[];
  unsignedImmediateExpansion: string[];
  threeOperandImmediate: string[];
  threeOperandRegister: string[];
  threeRegisterPseudo: string[];
  branchRegisterCompare: string[];
  branchImmediateCompare: string[];
  loadStorePseudoOffset: string[];
}

export type MipsPseudoFormGroup = {
  [Key in keyof MipsPseudoFormData]: ReadonlySet<string>;
};

export interface MipsPseudoExpansionForm {
  operands: string[];
  template: string[];
}

export interface MipsPseudoExpansionEntry {
  description: string;
  forms: MipsPseudoExpansionForm[];
}

export type MipsPseudoExpansions = Record<string, MipsPseudoExpansionEntry>;

interface MipsResourceData {
  registers: MipsRegisterInfo[];
  directives: string[];
  instructions: MipsInstruction[];
  syscalls: MipsSyscallInfo[];
  cp0Registers: MipsCp0RegisterInfo[];
  pseudoForms: MipsPseudoFormGroup;
}

export interface MipsInstructionMeta {
  memoryAlignment: Record<string, number>;
  writesFirstOperand: Record<string, boolean>;
  operandPatterns: Record<string, string[]>;
  sectionDirectives: Record<string, string>;
  storageDirectives: string[];
  coFixedSectionDirectives: string[];
}

export const mipsSemanticTokenTypes = [
  'mipsInstruction',
  'mipsRealInstruction',
  'mipsRInstruction',
  'mipsIInstruction',
  'mipsJInstruction',
  'mipsSpecialInstruction',
  'mipsPseudoInstruction',
  'mipsRegister',
  'mipsCp0Register',
  'mipsMacro',
  'mipsMacroParameter',
  'mipsLabel',
  'mipsDataSymbol',
  'mipsEqvSymbol'
] as const;

export type MipsSemanticTokenType = typeof mipsSemanticTokenTypes[number];
export type MipsInstructionTokenMode = CoSettings['mips']['instructionTokenMode'];

const mipsResourceData = loadMipsResourceData();
const mipsInstructionMeta = loadMipsInstructionMeta();
const registerInfos = mipsResourceData.registers;
const registerByNumber = new Map(registerInfos.map((info) => [info.number, info]));
const registerAliases = new Map(registerInfos.flatMap((info) => info.names.map((name) => [name.toLowerCase(), info.names[0].toLowerCase()] as const)));

export const registerNames = new Set(registerInfos.flatMap((info) => info.names.map((name) => name.toLowerCase())));
export const registerDescriptions = new Map<string, string>();
export const directives = new Set(mipsResourceData.directives);
export const instructions: Record<string, MipsInstruction> = makeInstructionMap(mipsResourceData.instructions);
export const syscalls = mipsResourceData.syscalls;
export const syscallsByCode = new Map(syscalls.map((syscall) => [syscall.code, syscall]));
export const cp0Registers = mipsResourceData.cp0Registers;
export const cp0RegistersByNumber = new Map(cp0Registers.map((register) => [register.number, register]));
export const pseudoForms = mipsResourceData.pseudoForms;
export const instructionMeta = mipsInstructionMeta;
export const pseudoExpansions = loadPseudoExpansions();

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

export function isFloatingPointRegister(value: string): boolean {
  return /^\$f(?:[0-9]|[12][0-9]|3[01])$/i.test(value);
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

export function instructionSemanticTokenType(
  instruction: MipsInstruction,
  tokenMode: MipsInstructionTokenMode,
  usesPseudoForm = false
): MipsSemanticTokenType {
  if (tokenMode === 'same') {
    return 'mipsInstruction';
  }
  if (tokenMode === 'realVsPseudo') {
    return usesPseudoForm || instruction.type === 'pseudo' ? 'mipsPseudoInstruction' : 'mipsRealInstruction';
  }
  if (usesPseudoForm) {
    return 'mipsPseudoInstruction';
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
  const syscalls = readJsonResource<MipsSyscallInfo[]>(path.join(resourceRoot, 'syscalls.json'));
  const cp0Registers = readJsonResource<MipsCp0RegisterInfo[]>(path.join(resourceRoot, 'cp0Registers.json'));
  const pseudoForms = normalizePseudoForms(readJsonResource<MipsPseudoFormData>(path.join(resourceRoot, 'pseudoForms.json')));
  const loadedInstructions = readJsonResource<MipsInstruction[]>(path.join(resourceRoot, 'instructions.json'));
  const instructionList = loadedInstructions.map((instruction) => ({
    ...instruction,
    mnemonic: instruction.mnemonic.toLowerCase(),
    operands: normalizeOperandRange(instruction.operands),
    ...generatedInstructionDisplayFacts(instruction)
  }));

  validateMipsResources(registers, directiveList, instructionList, syscalls, cp0Registers);
  return {
    registers,
    directives: directiveList,
    instructions: instructionList,
    syscalls,
    cp0Registers,
    pseudoForms
  };
}

function loadMipsInstructionMeta(): MipsInstructionMeta {
  const resourceRoot = path.join(__dirname, '..', '..', '..', 'resources', 'mips');
  const loaded = readJsonResource<MipsInstructionMeta>(path.join(resourceRoot, 'instructionMeta.json'));
  return {
    ...loaded,
    memoryAlignment: {
      ...loaded.memoryAlignment,
      ...Object.fromEntries(isaDisplayInstructions
        .filter((instruction) => instruction.memoryAlignment !== undefined)
        .map((instruction) => [instruction.mnemonic, instruction.memoryAlignment!]))
    },
    writesFirstOperand: {
      ...loaded.writesFirstOperand,
      ...Object.fromEntries(isaDisplayInstructions
        .map((instruction) => [instruction.mnemonic, instruction.writesFirstOperand]))
    }
  };
}

function generatedInstructionDisplayFacts(
  instruction: MipsInstruction
): Pick<MipsInstruction, 'type' | 'delaySlot' | 'isa'> {
  const mnemonic = instruction.mnemonic.toLowerCase();
  const fact = isaDisplayInstructionByMnemonic.get(mnemonic);
  if (!fact) {
    return {
      type: instruction.type,
      delaySlot: instruction.delaySlot,
      isa: undefined
    };
  }
  if (instruction.pseudo) {
    throw new Error(`Real ISA instruction ${mnemonic} cannot be marked pseudo in LSP resources.`);
  }
  return {
    type: fact.type,
    delaySlot: fact.delaySlot || undefined,
    isa: fact
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

function validateMipsResources(
  registers: MipsRegisterInfo[],
  directiveList: string[],
  instructionList: MipsInstruction[],
  syscallList: MipsSyscallInfo[],
  cp0RegisterList: MipsCp0RegisterInfo[]
): void {
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
  for (const fact of isaDisplayInstructions) {
    if (!seen.has(fact.mnemonic)) {
      throw new Error(`Generated ISA instruction ${fact.mnemonic} has no LSP display entry.`);
    }
  }

  if (!Array.isArray(syscallList) || syscallList.some((syscall) => !Number.isInteger(syscall.code) || typeof syscall.name !== 'string')) {
    throw new Error('Invalid MIPS syscall resource.');
  }

  if (!Array.isArray(cp0RegisterList) || cp0RegisterList.some((register) => !Number.isInteger(register.number) || typeof register.name !== 'string')) {
    throw new Error('Invalid MIPS CP0 register resource.');
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

function normalizePseudoForms(data: MipsPseudoFormData): MipsPseudoFormGroup {
  return {
    registerRegisterImmediate: makeLowercaseSet(data.registerRegisterImmediate),
    bitwiseImmediate: makeLowercaseSet(data.bitwiseImmediate),
    signedImmediateExpansion: makeLowercaseSet(data.signedImmediateExpansion),
    unsignedImmediateExpansion: makeLowercaseSet(data.unsignedImmediateExpansion),
    threeOperandImmediate: makeLowercaseSet(data.threeOperandImmediate),
    threeOperandRegister: makeLowercaseSet(data.threeOperandRegister),
    threeRegisterPseudo: makeLowercaseSet(data.threeRegisterPseudo),
    branchRegisterCompare: makeLowercaseSet(data.branchRegisterCompare),
    branchImmediateCompare: makeLowercaseSet(data.branchImmediateCompare),
    loadStorePseudoOffset: makeLowercaseSet(data.loadStorePseudoOffset)
  };
}

function makeLowercaseSet(values: string[]): ReadonlySet<string> {
  if (!Array.isArray(values)) {
    throw new Error('Invalid MIPS pseudo form resource.');
  }
  return new Set(values.map((value) => value.toLowerCase()));
}

function loadPseudoExpansions(): MipsPseudoExpansions {
  try {
    const resourceRoot = path.join(__dirname, '..', '..', '..', 'resources', 'mips');
    return readJsonResource<MipsPseudoExpansions>(path.join(resourceRoot, 'pseudoExpansions.json'));
  } catch {
    return {};
  }
}
