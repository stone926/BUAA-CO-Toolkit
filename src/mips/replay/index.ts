// @index mips-replay — public replay facade and default legacy adapter registry
export * from './canonical';
export * from './engineRegistry';
export * from './programImage';
export * from './replayService';
export * from './sourceBundle';
export * from './types';

import { LegacyMarsReplayAdapter } from './legacyMarsAdapter';
import { ReplayAdapterRegistry } from './types';

/** Registry used by commands/CLI until builtin-ts registers its own phase-2/5 adapter. */
export function createDefaultReplayAdapterRegistry(trustedJavaCommand: string): ReplayAdapterRegistry {
  const registry = new ReplayAdapterRegistry();
  registry.register(new LegacyMarsReplayAdapter({ javaCommand: trustedJavaCommand }));
  return registry;
}
