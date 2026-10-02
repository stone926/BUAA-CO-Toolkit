// @index waveform-dump-setup — 普通与课程仿真共享的 dump 顶层、存储器发现与编译拒绝归因
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDirectory } from '../../fsUtil';
import type { MutableVerilogModuleProvider } from '../../language/verilog/moduleProvider';
import type { IverilogRunOptions } from '../../verilog/iverilogRunner';
import type { RunResult } from '../../types';
import { findDumpableMemories, type MemoryDump } from '../design/designHierarchy';
import {
  buildWaveformDumper,
  dumperRejection,
  type DumperRejection,
  dumpFileArgument,
  waveformDumperFileName,
  waveformDumperModuleName
} from '../design/waveformDumper';
import { createDesignModuleLookup } from './designModules';

const dumpfileOpenedPattern = /^VCD info: dumpfile (.+) opened for output\.?\s*$/m;

/** One compile attempt; callers may retry only the rejected memory dumps. */
export class WaveformDumpSetup {
  memories: readonly MemoryDump[];
  rejection: DumperRejection | undefined;
  private text = '';

  constructor(
    private readonly dump: vscode.Uri | ((testbenchName: string) => vscode.Uri),
    private readonly requestedMemories?: readonly MemoryDump[],
    private readonly registry?: MutableVerilogModuleProvider,
    private readonly maximumDumpBytes?: number
  ) {
    this.memories = requestedMemories ?? [];
  }

  hooks(): Pick<IverilogRunOptions, 'generatedTopModules' | 'acceptCompileResult' | 'shouldReportCompileFailure'> {
    const acceptCompileResult: NonNullable<IverilogRunOptions['acceptCompileResult']> = (result) => this.inspectCompile(result);
    return {
      acceptCompileResult,
      shouldReportCompileFailure: acceptCompileResult,
      generatedTopModules: async (context) => {
        const dump = typeof this.dump === 'function' ? this.dump(context.testbench.moduleName) : this.dump;
        await ensureDirectory(vscode.Uri.file(path.dirname(dump.fsPath)));
        if (this.requestedMemories === undefined) {
          const sources = [context.testbench.generatedUri, context.testbench.sourceUri, ...(context.sourceFiles ?? [])]
            .filter((uri): uri is vscode.Uri => uri?.scheme === 'file')
            .map((uri) => uri.fsPath);
          const lookup = await createDesignModuleLookup(this.registry ?? context.moduleRegistry, [...new Set(sources)]);
          const root = lookup(context.testbench.moduleName);
          this.memories = root ? findDumpableMemories(root, lookup) : [];
        }
        const moduleName = waveformDumperModuleName(context.folder.uri.fsPath);
        this.text = buildWaveformDumper({
          moduleName,
          testbench: context.testbench.moduleName,
          dumpFile: dumpFileArgument(context.outDir.fsPath, dump.fsPath),
          memories: this.memories,
          maximumDumpBytes: this.maximumDumpBytes
        });
        return [{ moduleName, fileName: waveformDumperFileName, text: this.text }];
      }
    };
  }

  /** Silent automatic compile failures do not invoke the runner's UI-report hook. */
  inspectCompile(result: RunResult): boolean {
    this.rejection = this.memories.length
      ? dumperRejection(`${result.stderr}\n${result.stdout}`, this.text, this.memories)
      : undefined;
    return this.rejection === undefined;
  }
}

export function describeDumpMemories(memories: readonly MemoryDump[]): string {
  const names = memories.slice(0, 3).map((memory) => memory.path);
  return memories.length > names.length ? `${names.join('、')} 等 ${memories.length} 个存储器` : names.join('、');
}

/** The dump the simulator actually opened; a testbench's own $dumpfile may win. */
export function locateDumpFile(stdout: string, workingDirectory: string): vscode.Uri | undefined {
  const match = dumpfileOpenedPattern.exec(stdout);
  return match ? vscode.Uri.file(path.resolve(workingDirectory, match[1].trim())) : undefined;
}
