// @index verilog-workspace-operation-queue — 同工作区共享仿真产物的可取消串行队列
import { normalizePathKey } from '../pathUtils';

interface WorkspaceQueueState {
  tail: Promise<void>;
  users: number;
}

const queues = new Map<string, WorkspaceQueueState>();

/**
 * Serialize operations that mutate one workspace's shared simulation files.
 * Cancellation only removes the waiting turn; it never interrupts its predecessor
 * or leaves later turns blocked behind an unresolved promise.
 */
export async function runSerializedWorkspaceOperation<T>(
  workspaceRoot: string,
  signal: AbortSignal | undefined,
  action: () => Promise<T>
): Promise<T | undefined> {
  const key = normalizePathKey(workspaceRoot);
  let state = queues.get(key);
  if (!state) {
    state = { tail: Promise.resolve(), users: 0 };
    queues.set(key, state);
  }

  const predecessor = state.tail;
  let completeTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    completeTurn = resolve;
  });
  state.tail = predecessor.then(() => turn);
  state.users++;

  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    completeTurn();
    state!.users--;
    if (state!.users === 0 && queues.get(key) === state) {
      queues.delete(key);
    }
  };

  const acquired = await waitForTurn(predecessor, signal);
  if (!acquired || signal?.aborted) {
    release();
    return undefined;
  }
  try {
    return await action();
  } finally {
    release();
  }
}

async function waitForTurn(
  predecessor: Promise<void>,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal?.aborted) {
    return false;
  }
  if (!signal) {
    await predecessor;
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (acquired: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(acquired);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void predecessor.then(() => finish(true));
  });
}
