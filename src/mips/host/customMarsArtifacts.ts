// @index mips-host — 用户配置的 Mars/class 闭包：有界发现、内容寻址快照和私有执行目录
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { resourcePath } from '../../resourcePaths';
import type { EngineArtifactIdentity } from '../providers/contracts';
import { ImmutableEngineArtifactRegistry, workspaceEngineRegistryRoot } from '../replay/engineRegistry';
import { customInstructionDirectory } from './customInstructionFiles';

export interface CustomMarsSettings {
  jar: string;
  java: string;
  timeoutMs: number;
}

export interface CustomMarsEnvironment {
  readonly registry: ImmutableEngineArtifactRegistry;
  readonly identity: EngineArtifactIdentity;
  readonly java: string;
  readonly timeoutMs: number;
  readonly root: string;
  readonly classes: readonly EngineArtifactIdentity[];
  readonly bridge: EngineArtifactIdentity;
}

export async function captureCustomMarsEnvironment(
  root: string, names: readonly string[], settings: CustomMarsSettings, signal?: AbortSignal
): Promise<CustomMarsEnvironment> {
  signal?.throwIfAborted();
  const configured = settings.jar.trim();
  if (!configured) throw new Error('发现自定义指令 .class，但未配置 co.toolchain.mars；请指定支持加载 .class 的魔改 Mars JAR');
  const jar = path.resolve(root, configured);
  try { if (!(await fs.stat(jar)).isFile()) throw new Error('不是普通文件'); }
  catch { throw new Error(`co.toolchain.mars 指向的 Mars JAR 不存在或不可读：${jar}`); }
  const directory = customInstructionDirectory(root);
  if (names.length > 256) throw new Error(`自定义指令目录 ${directory} 超过 256 个 class 文件`);
  const registry = new ImmutableEngineArtifactRegistry(workspaceEngineRegistryRoot(root), root);
  const runtime = await registry.registerFile('custom-mars-runtime', jar);
  const classes: EngineArtifactIdentity[] = [];
  let totalBytes = 0;
  for (const name of names) {
    signal?.throwIfAborted();
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error(`自定义 class 不是有界普通文件：${file}`);
    totalBytes += stat.size;
    if (totalBytes > 32 * 1024 * 1024) throw new Error('自定义指令 class 总大小超过 32 MiB');
    classes.push((await registry.registerFile(`custom-mars-instruction-${classes.length}`, file)).identity);
  }
  const bridge = (await registry.registerFile('custom-mars-bridge', resourcePath('mars', 'bridge', 'mars-bridge.jar'))).identity;
  return { registry, identity: { ...runtime.identity, dependencies: [bridge, ...classes] },
    java: settings.java, timeoutMs: settings.timeoutMs, root, classes, bridge };
}

export async function withStagedCustomMars<T>(environment: CustomMarsEnvironment, run: (stage: {
  directory: string; classPath: string; classes: readonly string[];
}) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'co-custom-mars-'));
  try {
    const runtime = await environment.registry.stageForExecution(environment.identity, path.join(directory, 'runtime'));
    const bridge = await environment.registry.stageForExecution(environment.bridge, path.join(directory, 'bridge'));
    const classDirectory = path.join(directory, 'classes');
    const classes: string[] = [];
    for (const identity of environment.classes) {
      const staged = await environment.registry.stageForExecution(identity, classDirectory);
      if (!path.basename(staged.path).includes('$')) classes.push(staged.path);
    }
    return await run({ directory, classPath: [bridge.path, runtime.path, classDirectory].join(path.delimiter), classes });
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('co-custom-mars-')) throw new Error('Invalid custom Mars staging path');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
