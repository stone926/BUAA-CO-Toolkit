import { describe, expect, it } from 'vitest';
import { engineRunWasCancelled } from '../courseTestMessages';

describe('engineRunWasCancelled', () => {
  it('trusts an explicit aborted result', () => {
    expect(engineRunWasCancelled({ stopped: true, stopReason: 'aborted' })).toBe(true);
  });

  it('recognizes builtin cooperative cancellation', () => {
    expect(engineRunWasCancelled({ stopped: true, stopReason: 'cancelled' })).toBe(true);
    expect(engineRunWasCancelled({ stopReason: 'cancelled' })).toBe(true);
  });

  it('does not relabel a completed failure when the signal aborts afterwards', () => {
    const controller = new AbortController();
    controller.abort();

    expect(engineRunWasCancelled({ stopped: false }, controller.signal)).toBe(false);
  });

  it('uses the signal only when no engine result exists', () => {
    const controller = new AbortController();
    controller.abort();

    expect(engineRunWasCancelled(undefined, controller.signal)).toBe(true);
  });
});
