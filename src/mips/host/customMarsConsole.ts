// @index mips-host — 普通 ASM 命令的外部 Mars 适配，复用指令类快照与结构化 bridge
import * as path from 'path';
import { withCapturedAssemblySource } from './sourceInput';
import type { BoundMarsInstructions } from './customInstructionService';
import type { MarsConsole } from './marsIo';
import { buildProgramImage, sourceUnitFingerprint } from '../core/programImage';

export async function runCustomMarsConsole(instructions: BoundMarsInstructions, sourcePath: string, root: string, execute: boolean, options: {
  delayedBranching: boolean; stdin?: string | Uint8Array; console?: MarsConsole; maxSteps?: number; signal?: AbortSignal;
}) {
  return withCapturedAssemblySource(sourcePath, root, async (input) => {
    const output = await instructions.run({ mode: execute ? 'console' : 'assemble', source: input.sourcePath,
      profile: 'ordinary', layout: 'Default', delayed: options.delayedBranching,
      cwd: path.dirname(sourcePath),
      stdin: options.stdin, console: options.console, maxSteps: options.maxSteps, signal: options.signal });
    const image = output.payload?.ok ? buildProgramImage({ segments: output.payload.segments,
      entryPc: output.payload.segments.find((s) => s.name === 'text')?.baseAddress,
      inputGraph: input.sources.map(sourceUnitFingerprint) }) : undefined;
    return { result: output.result, image };
  });
}
