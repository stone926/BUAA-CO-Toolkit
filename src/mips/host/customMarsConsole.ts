// @index mips-host — 普通 ASM 命令的外部 Mars 适配，复用指令类快照与结构化 bridge
import type * as vscode from 'vscode';
import * as path from 'path';
import { useDelayedBranching } from '../../config';
import { withCapturedAssemblySource } from './sourceInput';
import { captureCustomMarsEnvironment } from './customMarsArtifacts';
import { invokeCustomMars } from './customMarsBridge';
import type { MarsConsole } from './marsIo';
import { buildProgramImage, sourceUnitFingerprint } from '../core/programImage';

export async function runCustomMarsConsole(source: vscode.Uri, execute: boolean, options: {
  stdin?: string | Uint8Array; console?: MarsConsole; maxSteps?: number; signal?: AbortSignal;
}) {
  const environment = await captureCustomMarsEnvironment(source);
  return withCapturedAssemblySource(source.fsPath, environment.root, async (input) => {
    const output = await invokeCustomMars(environment, { mode: execute ? 'console' : 'assemble', source: input.sourcePath,
      profile: 'ordinary', layout: 'Default', delayed: useDelayedBranching(source),
      cwd: path.dirname(source.fsPath),
      stdin: options.stdin, console: options.console, maxSteps: options.maxSteps, signal: options.signal });
    const image = output.payload?.ok ? buildProgramImage({ segments: output.payload.segments,
      entryPc: output.payload.segments.find((s) => s.name === 'text')?.baseAddress,
      inputGraph: input.sources.map(sourceUnitFingerprint) }) : undefined;
    return { result: output.result, image };
  });
}
