import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureSourceGraph,
  defaultSourceCaptureLimits,
  loadAndVerifySourceGraph,
  sourceGraphFingerprint,
  type SourceGraphBundle
} from '../../mips/replay/sourceBundle';
import {
  maximumReplaySourceBytes,
  maximumReplaySourceDepth,
  maximumReplaySourceUnits
} from '../../mips/replay/boundedFile';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { workspace: string; caseDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-source-bundle-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const caseDir = path.join(root, 'case');
  fs.mkdirSync(workspace);
  fs.mkdirSync(caseDir);
  return { workspace, caseDir };
}

describe('legacy-compatible source graph capture', () => {
  it('recognizes comma-delimited MARS include directives', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, '.include,"lib.asm"\nnop\n');
    fs.writeFileSync(path.join(workspace, 'lib.asm'), 'ori $1,$0,1\n');

    const captured = await captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace });
    expect(captured.graph.units).toHaveLength(2);
    expect(captured.graph.edges).toMatchObject([{ requestedPath: 'lib.asm' }]);
    expect(fs.readFileSync(captured.rootMaterializedPath, 'utf8')).toContain('.include,"./source-0001.asm"');
  });

  it('does not treat .include text inside a quoted string as a directive', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, '.ascii ".include ", "foo"\nnop\n');

    const captured = await captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace });

    expect(captured.graph.units).toHaveLength(1);
    expect(captured.graph.edges).toEqual([]);
  });

  it('keeps comment markers inside escaped quoted strings and captures the following include', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    const include = path.join(workspace, 'lib.asm');
    fs.writeFileSync(include, 'ori $1,$0,1\n');
    fs.writeFileSync(root, `.ascii "x\\\"#y" .include "${include}"\nnop\n`);

    const captured = await captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace });

    expect(captured.graph.units).toHaveLength(2);
    expect(captured.graph.edges[0].requestedPath).toBe(include);
  });

  it('preserves stable MARS filename identity for lib.asm versus ./lib.asm', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, '.include "lib.asm"\n.include "./lib.asm"\nnop\n');
    fs.writeFileSync(path.join(workspace, 'lib.asm'), 'ori $1,$0,1\n');

    const captured = await captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace });
    expect(captured.graph.units).toHaveLength(3);
    expect(captured.graph.units[1].contentHash).toBe(captured.graph.units[2].contentHash);
    expect(captured.graph.edges.map((edge) => edge.to)).toEqual(['source-0001', 'source-0002']);
  });

  it('still rejects a repeated identical include spelling like stable MARS', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, '.include "lib.asm"\n.include "lib.asm"\n');
    fs.writeFileSync(path.join(workspace, 'lib.asm'), 'nop\n');

    await expect(captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace }))
      .rejects.toThrow(/legacy MARS filename identity/);
  });

  it('rejects parent traversal or symlink escape before copying include bytes', async () => {
    const { workspace, caseDir } = fixture();
    const outside = path.join(path.dirname(workspace), 'outside');
    fs.mkdirSync(outside);
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, 'must-not-be-copied');
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, '.include "../outside/secret.txt"\n');

    await expect(captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace }))
      .rejects.toThrow(/escapes the allowed workspace root/);
    const blobs = path.join(caseDir, 'source', 'blobs');
    expect(fs.existsSync(blobs) ? fs.readdirSync(blobs) : []).toEqual([]);

    fs.writeFileSync(root, '.include "linked/secret.txt"\n');
    fs.symlinkSync(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace }))
      .rejects.toThrow(/escapes the allowed workspace root/);
  });

  it('rejects backslashes in graph lookup and graph-owned artifact paths', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, 'nop\n');
    const captured = await captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace });

    await expect(loadAndVerifySourceGraph(caseDir, 'source\\graph.json'))
      .rejects.toThrow(/unsafe source bundle path/);

    fs.chmodSync(captured.graphPath, 0o644);
    for (const field of ['blobPath', 'materializedPath'] as const) {
      const tampered = structuredClone(captured.graph) as SourceGraphBundle;
      tampered.units[0][field] = tampered.units[0][field].replace(/\//g, '\\');
      fs.writeFileSync(captured.graphPath, JSON.stringify(tampered));
      await expect(loadAndVerifySourceGraph(caseDir, 'source/graph.json'))
        .rejects.toThrow(/source graph units are invalid/);
    }
  });

  it('rejects an oversized include before allocating or writing the source bundle', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, '.include "large.asm"\n');
    fs.writeFileSync(path.join(workspace, 'large.asm'), 'x'.repeat(128));

    await expect(captureSourceGraph(
      root,
      caseDir,
      undefined,
      { maxDepth: 4, maxUnits: 4, maxBytes: 64 },
      { allowedRoot: workspace }
    )).rejects.toThrow(/byte limit/);
    expect(fs.existsSync(path.join(caseDir, 'source'))).toBe(false);
  });

  it('streams a 16 MiB single-line token bomb without materializing every token', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    const leaf = 'nop\n';
    const suffix = '.include "leaf.asm"\n';
    const rootBytes = maximumReplaySourceBytes - Buffer.byteLength(leaf);
    const paddingBytes = rootBytes - Buffer.byteLength(suffix);
    expect(paddingBytes % 2).toBe(0);
    fs.writeFileSync(root, `${'a '.repeat(paddingBytes / 2)}${suffix}`);
    fs.writeFileSync(path.join(workspace, 'leaf.asm'), leaf);

    const captured = await captureSourceGraph(
      root,
      caseDir,
      undefined,
      { maxDepth: 1, maxUnits: 2, maxBytes: maximumReplaySourceBytes },
      { allowedRoot: workspace }
    );

    expect(captured.graph.units).toHaveLength(2);
    expect(captured.graph.edges).toMatchObject([{ requestedPath: 'leaf.asm' }]);
  }, 30_000);

  it('rejects a 16 MiB include-directive bomb at the trusted unit ceiling', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    const directive = '.include "x"\n';
    const repetitions = Math.floor(maximumReplaySourceBytes / Buffer.byteLength(directive));
    fs.writeFileSync(root, directive.repeat(repetitions));

    await expect(captureSourceGraph(
      root,
      caseDir,
      undefined,
      { maxDepth: 1, maxUnits: 2, maxBytes: maximumReplaySourceBytes },
      { allowedRoot: workspace }
    )).rejects.toThrow(/directive count exceeds the trusted ceiling 1/);
    expect(fs.existsSync(path.join(caseDir, 'source'))).toBe(false);
  }, 30_000);

  it('rewrites many includes in one linear pass', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    const includeCount = 128;
    const directives = Array.from({ length: includeCount }, (_, index) => {
      const name = `leaf-${index.toString().padStart(3, '0')}.asm`;
      fs.writeFileSync(path.join(workspace, name), '');
      return `.include "${name}"\n`;
    }).join('');
    const rootBytes = defaultSourceCaptureLimits.maxBytes;
    const paddingBytes = rootBytes - Buffer.byteLength(directives) - 1;
    fs.writeFileSync(root, `${directives}#${'x'.repeat(paddingBytes)}`);

    const captured = await captureSourceGraph(
      root,
      caseDir,
      undefined,
      { maxDepth: 1, maxUnits: includeCount + 1, maxBytes: rootBytes },
      { allowedRoot: workspace }
    );

    expect(captured.graph.units).toHaveLength(includeCount + 1);
    const materialized = fs.readFileSync(captured.rootMaterializedPath, 'utf8');
    expect(materialized).toContain('.include "./source-0001.asm"');
    expect(materialized).toContain(`.include "./source-${includeCount.toString().padStart(4, '0')}.asm"`);
  }, 30_000);

  it('recomputes topology, limits, and include directives from immutable blobs', async () => {
    const { workspace, caseDir } = fixture();
    const root = path.join(workspace, 'root.asm');
    fs.writeFileSync(root, '.include "lib.asm"\nnop\n');
    fs.writeFileSync(path.join(workspace, 'lib.asm'), 'ori $1,$0,1\n');
    const captured = await captureSourceGraph(root, caseDir, undefined, undefined, { allowedRoot: workspace });
    const graphFile = captured.graphPath;

    const oversized = structuredClone(captured.graph) as SourceGraphBundle;
    oversized.limits.maxBytes = maximumReplaySourceBytes + 1;
    oversized.graphFingerprint = sourceGraphFingerprint(oversized);
    fs.chmodSync(graphFile, 0o644);
    fs.writeFileSync(graphFile, JSON.stringify(oversized));
    await expect(loadAndVerifySourceGraph(caseDir, path.relative(caseDir, graphFile).replace(/\\/g, '/')))
      .rejects.toThrow(/limits are invalid/);

    for (const [field, value] of [
      ['maxDepth', maximumReplaySourceDepth + 1],
      ['maxUnits', maximumReplaySourceUnits + 1]
    ] as const) {
      const attackerDeclared = structuredClone(captured.graph) as SourceGraphBundle;
      attackerDeclared.limits[field] = value;
      attackerDeclared.graphFingerprint = sourceGraphFingerprint(attackerDeclared);
      fs.writeFileSync(graphFile, JSON.stringify(attackerDeclared));
      await expect(loadAndVerifySourceGraph(caseDir, path.relative(caseDir, graphFile).replace(/\\/g, '/')))
        .rejects.toThrow(/limits are invalid/);
    }

    const tooSmall = structuredClone(captured.graph) as SourceGraphBundle;
    tooSmall.limits.maxUnits = 1;
    tooSmall.graphFingerprint = sourceGraphFingerprint(tooSmall);
    fs.writeFileSync(graphFile, JSON.stringify(tooSmall));
    await expect(loadAndVerifySourceGraph(caseDir, path.relative(caseDir, graphFile).replace(/\\/g, '/')))
      .rejects.toThrow(/maxUnits/);

    const fakeDirective = structuredClone(captured.graph) as SourceGraphBundle;
    fakeDirective.edges[0].requestedPath = 'other.asm';
    fakeDirective.graphFingerprint = sourceGraphFingerprint(fakeDirective);
    fs.writeFileSync(graphFile, JSON.stringify(fakeDirective));
    await expect(loadAndVerifySourceGraph(caseDir, path.relative(caseDir, graphFile).replace(/\\/g, '/')))
      .rejects.toThrow(/parsed include directives/);

    const cyclic = structuredClone(captured.graph) as SourceGraphBundle;
    cyclic.edges[0].to = cyclic.rootId;
    cyclic.graphFingerprint = sourceGraphFingerprint(cyclic);
    fs.writeFileSync(graphFile, JSON.stringify(cyclic));
    await expect(loadAndVerifySourceGraph(caseDir, path.relative(caseDir, graphFile).replace(/\\/g, '/')))
      .rejects.toThrow(/acyclic discovery order/);
  });
});
