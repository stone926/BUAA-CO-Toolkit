import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { URI } from 'vscode-uri';
import { runProcessCore } from '../../../processCore';
import {
  buildIverilogIncludeArgs,
  buildIverilogEnvironment,
  preflightIverilogRuntime
} from '../../../verilog/iverilogRuntime';
import {
  parseIverilogDiagnostics,
  runIverilogSyntaxCheck
} from '../../../language/verilog/iverilogSyntaxCheck';

vi.mock('../../../processCore', () => ({
  runProcessCore: vi.fn()
}));

vi.mock('../../../verilog/iverilogRuntime', () => ({
  buildIverilogIncludeArgs: vi.fn((root: string) => ['-grelative-include', '-I', root]),
  buildIverilogEnvironment: vi.fn(() => ({ PATH: 'bundled-bin' })),
  preflightIverilogRuntime: vi.fn()
}));

const temporaryRoots: string[] = [];

function successfulRun() {
  return {
    ok: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    stopped: false,
    commandLine: '',
    cwd: ''
  };
}

async function temporaryProject(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'co-iverilog-syntax-'));
  temporaryRoots.push(root);
  return root;
}

describe('Icarus syntax checker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(preflightIverilogRuntime).mockResolvedValue({
      runtime: {
        rootDir: 'C:/extension/vendor/iverilog/win32-x64',
        binDir: 'C:/extension/vendor/iverilog/win32-x64/bin',
        libDir: 'C:/extension/vendor/iverilog/win32-x64/lib/ivl',
        iverilogPath: 'C:/extension/vendor/iverilog/win32-x64/bin/iverilog.exe',
        vvpPath: 'C:/extension/vendor/iverilog/win32-x64/bin/vvp.exe'
      },
      result: successfulRun(),
      version: 'Icarus Verilog 13.0'
    });
    vi.mocked(runProcessCore).mockResolvedValue(successfulRun());
  });

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) =>
      fs.promises.rm(root, { recursive: true, force: true })
    ));
  });

  it('uses source-relative/workspace includes and deterministic project source order', async () => {
    const root = await temporaryProject();
    const nestedDirectory = path.join(root, '中文 nested include path');
    await fs.promises.mkdir(nestedDirectory, { recursive: true });
    const first = path.join(nestedDirectory, 'a source.v');
    await fs.promises.writeFile(
      path.join(nestedDirectory, '课程 defs.vh'),
      '`define COURSE_VALUE 8\'h2a\n'
    );
    const second = path.join(root, '中文-z.v');
    await fs.promises.writeFile(second, 'module z; endmodule\n');
    await fs.promises.writeFile(first, [
      '`include "课程 defs.vh"',
      'module a; localparam [7:0] value = `COURSE_VALUE; endmodule',
      ''
    ].join('\n'));
    await fs.promises.writeFile(path.join(root, 'course.xise'), [
      '<project><files>',
      '<file xil_pn:name="中文 nested include path/a source.v" xil_pn:type="FILE_VERILOG">',
      '<association xil_pn:name="BehavioralSimulation" xil_pn:seqID="1"/>',
      '</file>',
      '<file xil_pn:name="中文-z.v" xil_pn:type="FILE_VERILOG">',
      '<association xil_pn:name="BehavioralSimulation" xil_pn:seqID="2"/>',
      '</file>',
      '</files></project>'
    ].join('\n'));
    const triggerUri = URI.file(first).toString();

    const result = await runIverilogSyntaxCheck({
      workspaceFolders: [{ uri: URI.file(root).toString(), name: 'workspace' }],
      triggerUri,
      extensionRoot: 'C:/extension',
      timeoutMs: 5000
    });

    expect(result.ok).toBe(true);
    expect(preflightIverilogRuntime).toHaveBeenCalledWith('C:/extension', {
      signal: undefined,
      timeoutMs: 5000
    });
    expect(buildIverilogEnvironment).toHaveBeenCalledOnce();
    const [command, args, runOptions] = vi.mocked(runProcessCore).mock.calls[0];
    expect(command).toBe('C:/extension/vendor/iverilog/win32-x64/bin/iverilog.exe');
    const [includeRoot, includeSources] = vi.mocked(buildIverilogIncludeArgs).mock.calls[0];
    expect(path.normalize(includeRoot).toLowerCase()).toBe(path.normalize(root).toLowerCase());
    expect(includeSources.map((file) => path.normalize(file).toLowerCase())).toEqual(
      [first, second].map((file) => path.normalize(file).toLowerCase())
    );
    expect(path.normalize(args[3]).toLowerCase()).toBe(path.normalize(root).toLowerCase());
    expect(args.slice(0, 3)).toEqual([
      '-g2005',
      '-grelative-include',
      '-I'
    ]);
    expect(args.slice(4, 6)).toEqual([
      '-tnull',
      '-i'
    ]);
    expect(args.slice(6).map((file) => path.basename(file))).toEqual(['a source.v', '中文-z.v']);
    expect(path.normalize(runOptions.cwd).toLowerCase()).toBe(path.normalize(root).toLowerCase());
    expect(runOptions).toMatchObject({
      env: { PATH: 'bundled-bin' },
      timeoutMs: 5000
    });
  });

  it('reports a missing extension root instead of guessing cwd or PATH', async () => {
    const root = await temporaryProject();
    const file = path.join(root, 'top.v');
    await fs.promises.writeFile(file, 'module top; endmodule\n');
    const triggerUri = URI.file(file).toString();

    const result = await runIverilogSyntaxCheck({
      workspaceFolders: [{ uri: URI.file(root).toString(), name: 'workspace' }],
      triggerUri,
      extensionRoot: undefined,
      timeoutMs: 5000
    });

    expect(result.toolchainError).toContain('扩展安装目录');
    expect(result.diagnosticsByUri.get(triggerUri)?.[0]).toMatchObject({
      code: 'iverilog-toolchain',
      severity: 1
    });
    expect(preflightIverilogRuntime).not.toHaveBeenCalled();
    expect(runProcessCore).not.toHaveBeenCalled();
  });

  it('turns runtime preflight failures into a trigger-document diagnostic', async () => {
    const root = await temporaryProject();
    const file = path.join(root, 'top.v');
    await fs.promises.writeFile(file, 'module top; endmodule\n');
    const triggerUri = URI.file(file).toString();
    vi.mocked(preflightIverilogRuntime).mockRejectedValue(new Error('missing bundled files'));

    const result = await runIverilogSyntaxCheck({
      workspaceFolders: [{ uri: URI.file(root).toString(), name: 'workspace' }],
      triggerUri,
      extensionRoot: 'C:/extension',
      timeoutMs: 5000
    });

    expect(result.toolchainError).toContain('missing bundled files');
    expect(result.diagnosticsByUri.get(triggerUri)?.[0].code).toBe('iverilog-toolchain');
    expect(runProcessCore).not.toHaveBeenCalled();
  });

  it('reports syntax process timeout on the trigger document', async () => {
    const root = await temporaryProject();
    const file = path.join(root, 'top.v');
    await fs.promises.writeFile(file, 'module top; endmodule\n');
    const triggerUri = URI.file(file).toString();
    vi.mocked(runProcessCore).mockResolvedValue({
      ...successfulRun(),
      ok: false,
      exitCode: null,
      timedOut: true,
      stopped: true,
      stopReason: 'timeout'
    });

    const result = await runIverilogSyntaxCheck({
      workspaceFolders: [{ uri: URI.file(root).toString(), name: 'workspace' }],
      triggerUri,
      extensionRoot: 'C:/extension',
      timeoutMs: 1
    });

    expect(result.timedOut).toBe(true);
    expect(result.diagnosticsByUri.get(triggerUri)?.[0]).toMatchObject({
      code: 'iverilog-syntax',
      message: 'Icarus Verilog syntax check timed out.'
    });
  });

  it('parses common error, warning, line, and column output', () => {
    const root = path.resolve('workspace with spaces');
    const file = path.join(root, 'cpu.v');
    const diagnostics = parseIverilogDiagnostics([
      `${file}:12:4: error: malformed statement`,
      `${file}:20: warning: implicit definition of wire signal`
    ].join('\n'), root);
    const items = diagnostics.get(URI.file(file).toString());

    expect(items?.[0]).toMatchObject({
      code: 'iverilog-syntax',
      message: 'malformed statement',
      severity: 1
    });
    expect(items?.[0].range.start).toEqual({ line: 11, character: 3 });
    expect(items?.[1]).toMatchObject({
      message: 'implicit definition of wire signal',
      severity: 2
    });
  });
});
