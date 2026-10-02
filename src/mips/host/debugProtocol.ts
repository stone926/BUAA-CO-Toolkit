// @index mips-host — Inspection acknowledgements while a debugger syscall remains suspended
import type { DebugCommand } from '../core/debug/api';
import { isDebugRecord, parseDebugCommand, requireDebugKeys } from '../core/debug/validation';

export type DebugInspectionCommand = Extract<DebugCommand, { kind: 'memory' | 'set-breakpoints' }>;
export interface DebugIoCommand { kind: 'mars-debug-command'; command: DebugInspectionCommand }

export function isDebugInspectionCommand(command: DebugCommand): command is DebugInspectionCommand {
  return command.kind === 'memory' || command.kind === 'set-breakpoints';
}

/** Ordinary IO responses remain unchanged; tagged ACKs cannot resume the syscall. */
export function parseDebugIoCommand(value: unknown): DebugInspectionCommand | undefined {
  if (!isDebugRecord(value) || value.kind !== 'mars-debug-command') return undefined;
  requireDebugKeys(value, ['kind', 'command']);
  const command = parseDebugCommand(value.command);
  if (!isDebugInspectionCommand(command)) throw new Error('Only inspection commands are permitted during debugger IO');
  return command;
}
