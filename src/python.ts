import { ChildProcess, spawn } from 'child_process';

/**
 * Python 命令探测与兜底。
 *
 * macOS 与较新的 Linux 发行版通常只提供 `python3`、没有 `python`，因此默认命令
 * 不能硬编码为 `python`。这里按平台给出候选顺序，并在用户未显式配置时探测出第一个
 * 可用的命令（见 config.ts 的 resolvePython）。
 */

/**
 * 按平台返回 Python 命令候选，按优先级排序。
 * - 非 Windows（macOS / Linux）：优先 `python3`，回退 `python`。
 * - Windows：优先 `python`，回退 py 启动器，最后 `python3`。
 */
export function pythonCandidates(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'win32'
    ? ['python', 'py', 'python3']
    : ['python3', 'python'];
}

/**
 * 未探测时使用的默认命令（候选列表的首项）。用于同步场景与探测全部失败时的回退，
 * 以便错误信息里出现合理的命令名。
 */
export function defaultPythonCommand(platform: NodeJS.Platform = process.platform): string {
  return pythonCandidates(platform)[0];
}

export type CommandProbe = (command: string) => Promise<boolean>;

/**
 * 依次用 probe 测试候选命令，返回第一个被接受的；都不可用时返回 undefined。
 * probe 注入便于测试。
 */
export async function firstWorkingCommand(
  candidates: readonly string[],
  probe: CommandProbe
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await probe(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 真实探测：`<command> --version` 能否在超时内以退出码 0 结束。
 * 命令不存在（ENOENT）会触发 error 事件而非抛出，这里统一归为不可用。
 */
export function commandResponds(command: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(ok);
    };

    let child: ChildProcess;
    try {
      child = spawn(command, ['--version'], { shell: false, windowsHide: true, stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(false);
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}
