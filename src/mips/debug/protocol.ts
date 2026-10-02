// @index mips-debug — Internal MARS workbench view contract, shared without VS Code dependencies
export type WorkbenchStatus = 'empty' | 'assembling' | 'paused' | 'running' | 'input' | 'exited' | 'stopped' | 'error';
export interface WorkbenchInstruction {
  address: number;
  word: number;
  instruction: string;
  source?: { id: string; name: string; line: number; text: string };
}
export interface WorkbenchRegister { name: string; value: number; changed: boolean; detail?: string }
export interface WorkbenchMemoryWord { address: number; value?: number; changed?: boolean }
export interface WorkbenchSyscall {
  code: number; name: string; parameters: string; returns: string; description: string;
  supported: boolean; category: string;
}
export interface WorkbenchState {
  status: WorkbenchStatus;
  title: string;
  mode: string;
  modeLabel: string;
  message: string;
  sourceChanged: boolean;
  pc?: number;
  steps: number;
  delaySlot: boolean;
  instructions: readonly WorkbenchInstruction[];
  registers: readonly WorkbenchRegister[];
  floatingPoint: readonly WorkbenchRegister[];
  cp0: readonly WorkbenchRegister[];
  memory: readonly WorkbenchMemoryWord[];
  memoryAddress: number;
  memoryRegions: readonly { name: string; address: number }[];
  symbols: readonly { name: string; value: number; segment?: string; kind?: 'label' | 'eqv' }[];
  breakpoints: readonly number[];
  console: string;
  inputPrompt?: string;
  syscalls: readonly WorkbenchSyscall[];
  instructionOffset: number;
  instructionCount: number;
}
export type WorkbenchRequest =
  | { type: 'ready' | 'assemble' | 'run' | 'pause' | 'step' | 'reset' | 'stop' | 'clearConsole' | 'eof' }
  | { type: 'mode'; mode: string }
  | { type: 'breakpoint' | 'memory'; address: number }
  | { type: 'listing'; offset: number; address?: number }
  | { type: 'input'; text: string }
  | { type: 'source'; address: number }
  | { type: 'export' };
export interface WorkbenchUpdate { type: 'state'; state: WorkbenchState }
