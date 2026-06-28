import * as fs from 'fs';
import * as path from 'path';

export function findFuse(isePath: string): string {
  const candidates = [
    path.join(isePath, 'bin', 'nt64', 'fuse.exe'),
    path.join(isePath, 'bin', 'nt', 'fuse.exe'),
    path.join(isePath, 'bin', 'lin64', 'fuse'),
    path.join(isePath, 'bin', 'lin', 'fuse')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function findIsimGui(isePath: string): string {
  const candidates = [
    path.join(isePath, 'bin', 'nt64', 'isimgui.exe'),
    path.join(isePath, 'bin', 'nt', 'isimgui.exe'),
    path.join(isePath, 'bin', 'lin64', 'isimgui'),
    path.join(isePath, 'bin', 'lin', 'isimgui')
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function isimExecutableName(stem: string, fusePath: string): string {
  return isWindowsIseTool(fusePath) ? `${stem}.exe` : stem;
}

export function buildIseEnvironment(isePath: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const fuse = findFuse(isePath);
  const binDir = path.dirname(fuse);
  const platform = path.basename(binDir);
  const pathKey = Object.keys(baseEnv).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const entries = [
    binDir,
    path.join(binDir, 'unwrapped'),
    path.join(isePath, 'lib', platform),
    baseEnv[pathKey] ?? ''
  ].filter(Boolean);
  return {
    XILINX: isePath,
    [pathKey]: entries.join(path.delimiter)
  };
}

function isWindowsIseTool(toolPath: string): boolean {
  const normalized = toolPath.replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('.exe') || /\/bin\/nt(?:64)?\//.test(normalized);
}
