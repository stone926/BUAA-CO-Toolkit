// @index mips-host — 有界 ASM/include 快照，供课程与普通 MARS 共用
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { SourceUnit } from '../core/api';
import type { AssemblerServiceInclude } from '../core/assembler/assemblyService';
import { captureSourceGraph, defaultSourceCaptureLimits, SourceGraphBundle } from '../replay/sourceBundle';
import { readBoundedRegularFile } from '../replay/boundedFile';

export async function loadCapturedSourceUnits(stageDir: string, graph: SourceGraphBundle): Promise<SourceUnit[]> {
  return await Promise.all(graph.units.map(async (unit) => {
    const bytes = await readBoundedRegularFile(path.join(stageDir, ...unit.blobPath.split('/')), {
      maximumBytes: graph.limits.maxBytes, expectedBytes: unit.bytes, label: `captured source unit ${unit.id}`
    });
    return { id: unit.id, uri: unit.provenanceUri, text: bytes.toString('utf8') };
  }));
}

export async function captureAssemblyInput(sourcePath: string, allowedRoot: string): Promise<{
  sources: readonly SourceUnit[]; includes: readonly AssemblerServiceInclude[];
}> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'co-mars-source-'));
  try {
    const { graph } = await captureSourceGraph(sourcePath, stage, undefined, { ...defaultSourceCaptureLimits }, { allowedRoot });
    const units = await loadCapturedSourceUnits(stage, graph);
    const root = units.find((unit) => unit.id === graph.rootId)!;
    return {
      sources: [root, ...units.filter((unit) => unit !== root)],
      includes: graph.edges.map((edge) => ({ fromId: edge.from, specifier: edge.requestedPath, toId: edge.to }))
    };
  } finally {
    const target = path.resolve(stage);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('co-mars-source-')) {
      throw new Error('Invalid MARS source staging directory');
    }
    await fs.rm(target, { recursive: true, force: true });
  }
}
