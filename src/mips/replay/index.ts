// @index mips-replay — public replay facade and default legacy adapter registry
export * from './canonical';
export * from './engineRegistry';
export * from './programImage';
export * from './replayService';
export * from './sourceBundle';
export * from './types';

import { LegacyMarsReplayAdapter } from './legacyMarsAdapter';
import { BuiltinTsReplayAdapter } from './builtinExecutionAdapter';
import { ReplayAdapterRegistry } from './types';

/** Registry used by commands/CLI. Builtin assembler replay still waits for phase 5. */
export function createDefaultReplayAdapterRegistry(trustedJavaCommand: string): ReplayAdapterRegistry {
  const registry = new ReplayAdapterRegistry();
  registry.register(new LegacyMarsReplayAdapter({ javaCommand: trustedJavaCommand }));
  registry.register(new BuiltinTsReplayAdapter());
  return registry;
}
