// @index mips-host — 有界 Java bridge 进程、结构化输出校验和交互 stdin 适配
import * as fs from 'fs/promises';
import * as path from 'path';
import { runProcessCore } from '../../processCore';
import type { RunResult } from '../../types';
import type { ProgramSegment } from '../core/api';
import type { CourseProfile } from '../core/generated/isaCatalog';
import { readBoundedRegularFile } from '../replay/boundedFile';
import { maximumReplayTraceBytes } from '../replay/boundedFile';
import { withStagedCustomMars, type CustomMarsEnvironment } from './customMarsArtifacts';
import type { MarsConsole } from './marsIo';

export interface CustomInstructionEncoding { mnemonic: string; mask: number; value: number; template: string }
export interface CustomMarsBridgeResult {
  protocolVersion: 1; ok: boolean; diagnostic?: string; javaVersion: string;
  stopReason?: 'halt-loop' | 'exited' | 'step-limit' | 'error'; instructions?: number; exitCode?: number;
  segments: ProgramSegment[];
  customInstructions: CustomInstructionEncoding[];
  sourceMap?: Array<{ address: number; path: string; line: number }>;
  symbols?: Array<{ name: string; value: number; kind: 'data' | 'text'; segment?: string | null }>;
  timerUsed?: boolean;
  timerActivated?: boolean;
  timerTimingObserved?: boolean;
}
export interface CustomMarsBridgeOptions {
  mode: 'assemble' | 'execute' | 'console'; source: string; profile: CourseProfile | 'ordinary';
  layout: string; delayed: boolean; maxSteps?: number; haltPc?: number; interruptSchedule?: readonly number[];
  expectedSegments?: readonly ProgramSegment[];
  stdin?: string | Uint8Array; console?: MarsConsole; signal?: AbortSignal;
  cwd?: string;
}

export async function invokeCustomMars(environment: CustomMarsEnvironment, options: CustomMarsBridgeOptions): Promise<{
  result: RunResult; payload?: CustomMarsBridgeResult;
}> {
  return withStagedCustomMars(environment, async (stage) => {
    const resultFile = path.join(stage.directory, 'result.json');
    const args = ['-Dfile.encoding=UTF-8', '-Djava.awt.headless=true', '-cp', stage.classPath, 'co.mars.bridge.Main',
      '--mode', options.mode, '--source', options.source, '--profile', options.profile, '--layout', options.layout,
      '--delayed', String(options.delayed), '--max-steps', String(options.maxSteps ?? 10_000_000), '--result', resultFile];
    for (const file of stage.classes) args.push('--class', file);
    if (options.haltPc !== undefined) args.push('--halt-pc', String(options.haltPc >>> 0));
    if (options.interruptSchedule?.length) args.push('--interrupt', options.interruptSchedule.join(','));
    if (options.expectedSegments) {
      const expected = path.join(stage.directory, 'expected-image.json');
      await fs.writeFile(expected, JSON.stringify({ segments: options.expectedSegments }));
      args.push('--expected-image', expected);
    }
    const processResult = await runProcessCore(environment.java, args, {
      cwd: options.cwd ?? path.dirname(options.source), timeoutMs: environment.timeoutMs, signal: options.signal,
      stdin: options.stdin,
      readStdin: options.console?.readLine ? (signal) => readConsoleLine(options.console!, signal) : undefined,
      onStdout: (text) => { void options.console?.write(text); },
      maxStdoutBytes: maximumReplayTraceBytes, maxStderrBytes: 2 * 1024 * 1024,
      commandLine: `${environment.java} co.mars.bridge.Main ${options.mode}`
    });
    const result: RunResult = { ...processResult };
    if (result.timedOut || result.stopped || result.exitCode !== 0) {
      result.ok = false;
      result.stderr = result.stderr || (result.timedOut ? '外部 Mars 运行超时' : result.stopped ? `外部 Mars 已停止：${result.stopReason}` : 'Java/Mars 启动失败，请检查 co.toolchain.java 和 co.toolchain.mars');
      return { result };
    }
    try {
      const bytes = await readBoundedRegularFile(resultFile, { maximumBytes: 16 * 1024 * 1024, label: 'custom Mars bridge result' });
      const payload = parseCustomMarsBridgeResult(JSON.parse(bytes.toString('utf8')));
      result.ok = payload.ok && payload.stopReason !== 'step-limit';
      result.stderr = payload.diagnostic ?? (payload.stopReason === 'step-limit' ? '外部 Mars 达到执行步数上限，程序未完成' : result.stderr);
      result.stopReason = payload.stopReason;
      result.exitCode = payload.exitCode ?? result.exitCode;
      return { result, payload };
    } catch (error) {
      return { result: { ...result, ok: false, stderr: `魔改 Mars 未返回有效结果：${error instanceof Error ? error.message : String(error)}` } };
    }
  });
}

export function parseCustomMarsBridgeResult(value: unknown): CustomMarsBridgeResult {
  const result = value as CustomMarsBridgeResult;
  const uint32 = (word: unknown) => typeof word === 'number' && Number.isInteger(word) && word >= 0 && word <= 0xffff_ffff;
  if (!result || result.protocolVersion !== 1 || typeof result.ok !== 'boolean' || typeof result.javaVersion !== 'string'
    || !result.javaVersion.length || result.javaVersion.length > 256
    || !Array.isArray(result.segments) || result.segments.length > 256 || !Array.isArray(result.customInstructions)
    || result.customInstructions.length > 256 || (result.diagnostic !== undefined && typeof result.diagnostic !== 'string')
    || (result.stopReason !== undefined && !['halt-loop', 'exited', 'step-limit', 'error'].includes(result.stopReason))
    || (result.instructions !== undefined && (!Number.isSafeInteger(result.instructions) || result.instructions < 0))
    || (result.timerUsed !== undefined && typeof result.timerUsed !== 'boolean')
    || (result.timerActivated !== undefined && typeof result.timerActivated !== 'boolean')
    || (result.timerTimingObserved !== undefined && typeof result.timerTimingObserved !== 'boolean')
    || (result.exitCode !== undefined && (!Number.isInteger(result.exitCode) || result.exitCode < -0x8000_0000 || result.exitCode > 0x7fff_ffff))) throw new Error('Invalid Mars bridge envelope');
  let totalWords = 0;
  for (const segment of result.segments) {
    if (!segment || !/^(?:(?:k?text)(?:@[\da-f]{8})?|k?data)$/.test(segment.name) || !uint32(segment.baseAddress)
      || segment.baseAddress % 4 !== 0 || !Array.isArray(segment.words) || segment.words.some((word) => !uint32(word))) throw new Error('Invalid Mars program segment');
    if (segment.baseAddress + segment.words.length * 4 > 0x1_0000_0000) throw new Error('Mars segment crosses uint32 address space');
    totalWords += segment.words.length;
  }
  if (totalWords > 1_048_576) throw new Error('Mars program image exceeds the host limit');
  for (const instruction of result.customInstructions) {
    if (!instruction || typeof instruction.mnemonic !== 'string' || !instruction.mnemonic.length || typeof instruction.template !== 'string'
      || !uint32(instruction.mask) || instruction.mask === 0 || !uint32(instruction.value)
      || ((instruction.value & instruction.mask) >>> 0) !== instruction.value) throw new Error('Invalid custom instruction encoding');
  }
  if (result.sourceMap !== undefined && (!Array.isArray(result.sourceMap) || result.sourceMap.length > totalWords
    || result.sourceMap.some((item) => !uint32(item.address) || typeof item.path !== 'string' || !Number.isInteger(item.line) || item.line < 1))) throw new Error('Invalid Mars source map');
  if (result.symbols !== undefined && (!Array.isArray(result.symbols) || result.symbols.length > 8192
    || result.symbols.some((item) => !item || typeof item.name !== 'string' || !item.name.length || !uint32(item.value)
      || !['data', 'text'].includes(item.kind) || (item.segment != null && typeof item.segment !== 'string')))) throw new Error('Invalid Mars symbols');
  return result;
}

function readConsoleLine(console: MarsConsole, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); resolve(undefined); };
    signal.addEventListener('abort', abort, { once: true });
    void console.readLine!().then((line) => { signal.removeEventListener('abort', abort); resolve(line); }, (error) => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}
