// @index orchestration — MARS 交互终端的 shell 选择与字面参数编码
import * as path from 'path';

/** Select a known shell so command quoting never depends on the user's terminal profile. */
export function marsTerminalInvocation(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform
): { shellPath: string; command: string } {
  if (platform === 'win32') {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return {
      shellPath: path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      command: `& ${[command, ...args].map(quote).join(' ')}`
    };
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;
  return { shellPath: '/bin/sh', command: [command, ...args].map(quote).join(' ') };
}
