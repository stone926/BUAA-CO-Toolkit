import * as path from 'path';
import * as vscode from 'vscode';
import { getIsePath, getSimTime, getTestbench } from './config';
import { copyAsmCaseArtifact, updateAsmCaseArtifacts } from './asmCaseStore';
import type { AsmCase } from './asmCaseStore';
import { pathExists, workspaceFolderFor, writeTextFile } from './fsUtil';
import { launchTool, runTool } from './process';
import { buildIseEnvironment } from './toolchain';
import { AppServices, RunResult } from './types';
import type { MutableVerilogModuleProvider } from './language/verilog/moduleProvider';
import { buildIsimVcdTcl, buildIsimWaveTcl } from './verilogSimulationFiles';
import { samePath, simulationOutputDirectory } from './verilogIsimOutput';

interface WaveformProjectFiles {
  tcl: vscode.Uri;
  outDir: vscode.Uri;
}

interface WaveformCompileOptions {
  resource?: vscode.Uri;
  moduleRegistry?: MutableVerilogModuleProvider;
  debug?: boolean;
  tclFileName?: string;
  tclText?: string;
}

interface WaveformCompileOutput {
  generated: WaveformProjectFiles;
  fuseResult: RunResult;
  testbenchName: string;
  exePath: string;
  asmCase?: AsmCase;
}

type CompileIsimForWaveform = (
  services: AppServices,
  options: WaveformCompileOptions
) => Promise<WaveformCompileOutput | undefined>;

export interface VerilogWaveformDependencies {
  compileIsim: CompileIsimForWaveform;
  moduleRegistry?: MutableVerilogModuleProvider;
}

export async function openIsimWaveform(
  services: AppServices,
  dependencies: VerilogWaveformDependencies
): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const simTime = getSimTime(activeUri);
  const compiled = await dependencies.compileIsim(services, {
    resource: activeUri,
    moduleRegistry: dependencies.moduleRegistry,
    debug: true,
    tclFileName: 'co_wave.tcl',
    tclText: buildIsimWaveTcl(simTime)
  });
  if (!compiled) {
    return;
  }
  const isePath = getIsePath(activeUri);
  const iseEnv = buildIseEnvironment(isePath);
  const result = await launchTool(compiled.exePath, ['-gui', '-tclbatch', path.basename(compiled.generated.tcl.fsPath)], {
    cwd: compiled.generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: iseEnv
  });
  if (result.ok) {
    if (compiled.asmCase) {
      await updateAsmCaseArtifacts(compiled.asmCase, 'verilog', {
        waveTcl: compiled.generated.tcl.fsPath,
        isimExecutable: compiled.exePath
      });
    }
    vscode.window.showInformationMessage('已启动 ISim 波形窗口');
  } else {
    vscode.window.showErrorMessage('启动 ISim 波形窗口失败。请查看插件输出面板');
  }
}

export async function exportVcdWaveform(
  services: AppServices,
  dependencies: VerilogWaveformDependencies
): Promise<void> {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const simTime = getSimTime(activeUri);
  const fallbackIsimDir = vscode.Uri.file(path.join(workspaceFolderFor(activeUri)?.uri.fsPath ?? process.cwd(), '.co', 'isim'));
  const simOutDir = await simulationOutputDirectory(activeUri, fallbackIsimDir);
  const preliminaryTestbenchName = getTestbench(activeUri);
  const preliminaryVcd = vscode.Uri.file(path.join(simOutDir.fsPath, `${preliminaryTestbenchName}.vcd`));
  const compiled = await dependencies.compileIsim(services, {
    resource: activeUri,
    moduleRegistry: dependencies.moduleRegistry,
    debug: true,
    tclFileName: 'co_vcd.tcl',
    tclText: buildIsimVcdTcl(preliminaryVcd.fsPath, preliminaryTestbenchName, simTime)
  });
  if (!compiled) {
    return;
  }

  const vcd = vscode.Uri.file(path.join(simOutDir.fsPath, `${compiled.testbenchName}.vcd`));
  if (!samePath(vcd.fsPath, preliminaryVcd.fsPath)) {
    await writeTextFile(compiled.generated.tcl, buildIsimVcdTcl(vcd.fsPath, compiled.testbenchName, simTime));
  }
  const isePath = getIsePath(activeUri);
  const iseEnv = buildIseEnvironment(isePath);
  const result = await runTool(compiled.exePath, ['-nolog', '-tclbatch', path.basename(compiled.generated.tcl.fsPath)], {
    cwd: compiled.generated.outDir.fsPath,
    output: services.output,
    resource: activeUri,
    env: iseEnv
  });
  if (result.ok && await pathExists(vcd.fsPath)) {
    if (compiled.asmCase) {
      await copyAsmCaseArtifact(compiled.asmCase, 'verilog', vcd, path.basename(vcd.fsPath), 'vcd');
    }
    await vscode.commands.executeCommand('revealFileInOS', vcd);
    vscode.window.showInformationMessage(`已导出 VCD 波形：${path.basename(vcd.fsPath)}`);
  } else {
    vscode.window.showErrorMessage('导出 VCD 波形失败。请查看插件输出面板');
  }
}
