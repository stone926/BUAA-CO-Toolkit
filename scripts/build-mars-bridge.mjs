// @index build-script — Rebuild the Java 8 reflection bridge without a MARS dependency.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMarsBridgeInputs, writeMarsBridgeManifest } from './check-mars-bridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = path.join(root, 'resources', 'mars', 'bridge');
const build = await mkdtemp(path.join(tmpdir(), 'co-mars-bridge-'));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed:\n${result.stdout}${result.stderr}`);
}
try {
  await mkdir(bridge, { recursive: true });
  const inputs = await loadMarsBridgeInputs(root);
  run(process.env.JAVAC ?? 'javac', ['--release', '8', '-encoding', 'UTF-8', '-classpath', inputs.asmFile, '-d', build, ...inputs.javaFiles]);
  run(process.env.JAR ?? 'jar', ['--extract', '--file', inputs.asmFile, 'org'], build);
  await mkdir(path.join(build, 'META-INF'), { recursive: true });
  await writeFile(path.join(build, 'META-INF', 'LICENSE-ASM.txt'), inputs.licenseText);
  // A fixed archive timestamp keeps artifact rebuilds deterministic.
  run(process.env.JAR ?? 'jar', ['--create', '--file', inputs.artifactFile, '--date=2020-01-01T00:00:00Z', '-C', build, '.']);
  await writeMarsBridgeManifest(root);
  console.log(`Built ${path.relative(root, inputs.artifactFile)} and refreshed artifact-manifest.json`);
} finally {
  await rm(build, { recursive: true, force: true });
}
