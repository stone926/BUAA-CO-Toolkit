// @index verilog-automatic-compile-pool — 有界共享自动测试编译目录与仿真读租约
import * as path from 'path';
import { CO_IVERILOG_DIR } from '../constants';
import { normalizePathKey } from '../pathUtils';

interface CompileDirectory {
  key?: string;
  users: number;
  readers: number;
  touched: number;
}

interface WorkspacePool {
  directories: CompileDirectory[];
  wake: Set<() => void>;
  acquirers: number;
}

export interface AutomaticCompileLease {
  readonly directory: string;
  waitForReaders(signal?: AbortSignal): Promise<boolean>;
  startReading(): void;
  release(): void;
}

const pools = new Map<string, WorkspacePool>();
const maximumWorkspacePools = 8;
const compileDirectoriesPerWorkspace = 8;
let nextTouch = 0;

/** Equal generated testbenches share compiler paths; active VVP readers prevent replacement. */
export async function acquireAutomaticCompileDirectory(
  workspaceRoot: string,
  testbenchSha256: string,
  signal?: AbortSignal
): Promise<AutomaticCompileLease | undefined> {
  const workspaceKey = normalizePathKey(path.resolve(workspaceRoot));
  let pool = pools.get(workspaceKey);
  if (!pool) {
    pool = {
      directories: Array.from({ length: compileDirectoriesPerWorkspace }, () => ({ users: 0, readers: 0, touched: 0 })),
      wake: new Set(),
      acquirers: 0
    };
    pools.set(workspaceKey, pool);
  }
  pool.acquirers++;
  try {
    while (!signal?.aborted) {
      const matching = pool.directories.findIndex(directory => directory.key === testbenchSha256);
      const available = pool.directories.map((directory, index) => ({ directory, index }))
        .filter(candidate => candidate.directory.users === 0)
        .sort((left, right) => left.directory.touched - right.directory.touched);
      const index = matching >= 0 ? matching : available[0]?.index ?? -1;
      if (index >= 0) {
        const entry = pool.directories[index];
        entry.key = testbenchSha256;
        entry.users++;
        entry.touched = ++nextTouch;
        let released = false;
        let reading = false;
        return {
          directory: path.join(workspaceRoot, CO_IVERILOG_DIR, 'automatic', `build-${index}`),
          waitForReaders: async readSignal => {
            while (entry.readers && !readSignal?.aborted) await waitForWake(pool!, readSignal);
            return !readSignal?.aborted;
          },
          startReading: () => {
            if (reading || released) return;
            reading = true;
            entry.readers++;
          },
          release: () => {
            if (released) return;
            released = true;
            entry.users--;
            if (reading) entry.readers--;
            for (const wake of [...pool!.wake]) wake();
            trimIdlePools();
          }
        };
      }
      await waitForWake(pool, signal);
    }
    return undefined;
  } finally {
    pool.acquirers--;
    trimIdlePools();
  }
}

async function waitForWake(pool: WorkspacePool, signal?: AbortSignal): Promise<void> {
  await new Promise<void>(resolve => {
    const wake = (): void => {
      pool.wake.delete(wake);
      signal?.removeEventListener('abort', wake);
      resolve();
    };
    pool.wake.add(wake);
    signal?.addEventListener('abort', wake, { once: true });
    if (signal?.aborted) wake();
  });
}

function trimIdlePools(): void {
  for (const [key, pool] of pools) {
    if (pools.size <= maximumWorkspacePools) return;
    if (!pool.acquirers && pool.directories.every(directory => directory.users === 0)) pools.delete(key);
  }
}
