// @index startup-trace — optional startup/performance tracing
export interface StartupTraceOutput {
  appendLine(message: string): void;
}

const enabledValues = new Set(['1', 'true', 'yes', 'on']);
const processStartedAt = Date.now();

export function startupTraceEnabled(): boolean {
  const value = process.env.CO_TRACE_STARTUP ?? process.env.BUAA_CO_TRACE_STARTUP ?? '';
  return enabledValues.has(value.trim().toLowerCase());
}

export function traceStartup(message: string, output?: StartupTraceOutput): void {
  if (!startupTraceEnabled()) {
    return;
  }
  const elapsed = Date.now() - processStartedAt;
  const line = `[startup +${elapsed}ms] ${message}`;
  if (output) {
    output.appendLine(line);
  } else {
    // Server-side tracing has no OutputChannel; keep it visible in extension host logs.
    console.info(line);
  }
}

export function timeStartup(label: string, output?: StartupTraceOutput): () => void {
  const startedAt = Date.now();
  return () => {
    traceStartup(`${label} completed in ${Date.now() - startedAt}ms`, output);
  };
}
