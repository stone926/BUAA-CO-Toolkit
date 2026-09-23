import * as path from 'path';
import { CO_TB_DIR } from './constants';
import { renderResourceTemplate } from './templates/templateRegistry';

export const generatedTestbenchMarker = '// CO_GENERATED_RUNTIME_TESTBENCH';
export const automaticRuntimeTestbenchName = 'co_generated_auto_tb';
export const p7AutoRuntimeTestbenchName = 'co_generated_p7_auto_tb';
export const verilogProjectExcludeGlob = '**/{node_modules,out,.git,.co,.vscode,.vscode-test}/**';

const userTestbenchDirectoryParts = CO_TB_DIR.split('/');

export function runtimeTestbenchFileName(testbenchName: string): string {
  return `co_generated_${safeFileStem(testbenchName)}.v`;
}

/** File name of a user-owned testbench under `.co/tb`; it matches the module name when that is filename-safe. */
export function userTestbenchFileName(testbenchName: string): string {
  return `${safeFileStem(testbenchName)}.v`;
}

/**
 * Whether `file` lies under `<workspaceRoot>/.co/tb`. Project discovery skips
 * `.co`, so callers must compile or check these user testbenches explicitly.
 */
export function isUserTestbenchPath(workspaceRoot: string, file: string): boolean {
  const relative = path.relative(workspaceRoot, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  const parts = relative.split(/[\\/]+/);
  return parts.length > userTestbenchDirectoryParts.length
    && userTestbenchDirectoryParts.every((part, index) => parts[index].toLowerCase() === part);
}

export function generatedRuntimeTestbenchText(testbenchText: string): string {
  return `${generatedTestbenchMarker}\n\`default_nettype wire\n${testbenchText}`;
}

export function isGeneratedRuntimeTestbench(text: string): boolean {
  return text.includes(generatedTestbenchMarker);
}

export function buildIseProjectText(verilogFiles: readonly string[]): string {
  const projectEntries = verilogFiles
    .map((file) => `Verilog work "${file.replace(/\\/g, '/')}"`)
    .join('\n');
  return renderResourceTemplate('isim/project.prj', { projectEntries });
}

export function buildIsimRunTcl(simTime: string): string {
  return renderResourceTemplate('isim/run.tcl', { simTime });
}

export function buildIsimWaveTcl(simTime: string): string {
  return renderResourceTemplate('isim/wave.tcl', { simTime });
}

export function buildIsimVcdTcl(vcdFile: string, testbenchName: string, simTime: string): string {
  return renderResourceTemplate('isim/vcd.tcl', {
    simTime,
    testbenchName,
    vcdFile: quoteTclString(vcdFile.replace(/\\/g, '/'))
  });
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'testbench';
}

function quoteTclString(value: string): string {
  return `"${value.replace(/["\\]/g, (match) => `\\${match}`)}"`;
}
