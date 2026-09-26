import * as path from 'path';
import { CO_TB_DIR } from './constants';

export const generatedTestbenchMarker = '// CO_GENERATED_RUNTIME_TESTBENCH';
export const automaticRuntimeTestbenchName = 'co_generated_auto_tb';
export const p7AutoRuntimeTestbenchName = 'co_generated_p7_auto_tb';
export const verilogProjectExcludeGlob = '**/{node_modules,out,.git,.co,.vscode,.vscode-test}/**';

const userTestbenchDirectoryParts = CO_TB_DIR.split('/');

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

/** User-created Verilog testbenches are identified by the file name, not by module-name guesses. */
export function isCustomTestbenchPath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  if (normalized.split('/').some((part) => part.toLowerCase() === '.co')) {
    return false;
  }
  return /(?:_tb|_testbench)\.v$/i.test(path.basename(normalized));
}

/** The simulator's private files must never become an interactive testbench. */
export function isPrivateRuntimeTestbenchPath(file: string): boolean {
  return /(?:^|[\\/])\.co[\\/](?:iverilog|isim)[\\/]/i.test(file);
}

export function generatedRuntimeTestbenchText(testbenchText: string): string {
  return `${generatedTestbenchMarker}\n\`default_nettype wire\n${testbenchText}`;
}

export function isGeneratedRuntimeTestbench(text: string): boolean {
  return text.includes(generatedTestbenchMarker);
}

function safeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_') || 'testbench';
}
