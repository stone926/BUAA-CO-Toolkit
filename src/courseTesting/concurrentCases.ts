// @index concurrent-cases — 有界测试调度：阶段屏障、固定槽、同产物互斥与失败取消

export interface ConcurrentCaseOptions<T, R> {
  concurrency: number;
  signal?: AbortSignal;
  /** Ordered phases are barriers: every earlier phase must finish first. */
  phase: (item: T) => number;
  /** Cases sharing mutable artifacts must never overlap. */
  key: (item: T) => string;
  run: (item: T, index: number, slot: number, signal: AbortSignal) => Promise<R>;
  shouldStop: (result: R) => boolean;
  /** Completion is serialized; failing work aborts peers before this callback. */
  completed: (result: R, item: T, index: number) => Promise<void>;
}

/** Always drains in-flight work before returning, including cancellation and callback errors. */
export async function runConcurrentCases<T, R>(items: readonly T[], options: ConcurrentCaseOptions<T, R>): Promise<void> {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('Test concurrency must be a positive integer.');
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let completion = Promise.resolve();
  let failure: unknown;
  let failed = false;
  const pending = items.map((item, index) => ({ item, index, phase: options.phase(item), key: options.key(item) }))
    .sort((a, b) => a.phase - b.phase || a.index - b.index);
  const activeKeys = new Set<string>();
  const active = new Map<number, Promise<void>>();
  const fail = (error: unknown): void => {
    if (!failed) { failed = true; failure = error; }
    abort();
  };
  try {
    while ((pending.length || active.size) && !failed) {
      const phase = pending[0]?.phase;
      // A phase only advances after all slots from the previous phase drain.
      const batch = pending.filter(item => item.phase === phase);
      const remaining = new Set(batch);
      while (remaining.size || active.size) {
        if (!controller.signal.aborted) {
          for (let slot = 0; slot < options.concurrency; slot++) {
            if (active.has(slot)) continue;
            const next = [...remaining].find(item => !activeKeys.has(item.key));
            if (!next) break;
            remaining.delete(next);
            activeKeys.add(next.key);
            const job = Promise.resolve().then(async () => {
              if (controller.signal.aborted) return;
              const result = await options.run(next.item, next.index, slot, controller.signal);
              if (options.shouldStop(result)) abort();
              const saved = completion.then(() => options.completed(result, next.item, next.index));
              completion = saved.catch(fail);
              await completion;
            }).catch(fail).finally(() => {
              activeKeys.delete(next.key);
              active.delete(slot);
            });
            active.set(slot, job);
          }
        }
        if (!active.size) break;
        await Promise.race(active.values());
      }
      pending.splice(0, batch.length);
      if (controller.signal.aborted) break;
    }
  } finally {
    abort();
    await Promise.all(active.values());
    await completion;
    options.signal?.removeEventListener('abort', abort);
  }
  if (failed) throw failure;
}
