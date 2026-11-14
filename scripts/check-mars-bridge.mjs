// @index build-script — Check shipped Java bridge freshness using Node only.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const bridgeDirectory = 'resources/mars/bridge';
const sourceDirectory = `${bridgeDirectory}/src/co/mars/bridge`;
const manifestPath = `${bridgeDirectory}/artifact-manifest.json`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeText = text => text.replace(/\r\n/g, '\n');

/** One targeted build/check inventory; no workspace scan or Java invocation. */
export async function loadMarsBridgeInputs(root = repositoryRoot) {
  const dependencyPath = `${bridgeDirectory}/vendor/DEPENDENCIES.json`;
  const dependencyText = normalizeText(await readFile(path.join(root, dependencyPath), 'utf8'));
  const dependencies = JSON.parse(dependencyText).dependencies;
  if (!Array.isArray(dependencies) || dependencies.length !== 1 || dependencies[0].name !== 'org.ow2.asm:asm') {
    throw new Error('MARS bridge must declare exactly one pinned ASM core dependency');
  }
  const dependency = dependencies[0];
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(dependency.version) || !/^[0-9a-f]{64}$/.test(dependency.sha256)) {
    throw new Error('MARS bridge ASM version/checksum is invalid');
  }
  const asmPath = `${bridgeDirectory}/vendor/asm-${dependency.version}.jar`;
  const asmBytes = await readFile(path.join(root, asmPath));
  if (digest(asmBytes) !== dependency.sha256) throw new Error('Bundled ASM dependency checksum mismatch');
  const javaNames = (await readdir(path.join(root, sourceDirectory)))
    .filter(name => name.endsWith('.java')).sort();
  if (!javaNames.length) throw new Error('MARS bridge Java sources are missing');
  const javaPaths = javaNames.map(name => `${sourceDirectory}/${name}`);
  const licensePath = `${bridgeDirectory}/vendor/LICENSE-ASM.txt`;
  const licenseText = normalizeText(await readFile(path.join(root, licensePath), 'utf8'));
  const textPaths = [
    ...javaPaths,
    'scripts/build-mars-bridge.mjs',
    'scripts/check-mars-bridge.mjs',
    dependencyPath,
    licensePath,
    `${bridgeDirectory}/vendor/asm-${dependency.version}.pom`,
  ].sort();
  const inputs = await Promise.all(textPaths.map(async relativePath => ({
    path: relativePath,
    sha256: digest(Buffer.from(normalizeText(await readFile(path.join(root, relativePath), 'utf8')), 'utf8')),
  })));
  inputs.push({ path: asmPath, sha256: digest(asmBytes) });
  inputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    inputs,
    javaFiles: javaPaths.map(relativePath => path.join(root, relativePath)),
    asmFile: path.join(root, asmPath),
    licenseText,
    artifactFile: path.join(root, bridgeDirectory, 'mars-bridge.jar'),
  };
}

async function captureManifest(root) {
  const build = await loadMarsBridgeInputs(root);
  const artifact = await readFile(build.artifactFile);
  return {
    schemaVersion: 1,
    textNormalization: 'CRLF-to-LF',
    inputs: build.inputs,
    artifact: { path: `${bridgeDirectory}/mars-bridge.jar`, sha256: digest(artifact), bytes: artifact.length },
  };
}

export async function writeMarsBridgeManifest(root = repositoryRoot) {
  const manifest = await captureManifest(root);
  await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function checkMarsBridge(root = repositoryRoot) {
  const current = await captureManifest(root);
  let recorded;
  try { recorded = JSON.parse(await readFile(path.join(root, manifestPath), 'utf8')); }
  catch (error) { throw new Error(`MARS bridge artifact receipt is missing or invalid: ${error.message}`); }
  if (JSON.stringify(recorded) === JSON.stringify(current)) return current;
  const previous = new Map((Array.isArray(recorded.inputs) ? recorded.inputs : []).map(input => [input.path, input.sha256]));
  const changed = current.inputs.filter(input => previous.get(input.path) !== input.sha256).map(input => input.path);
  const present = new Set(current.inputs.map(input => input.path));
  changed.push(...[...previous.keys()].filter(relativePath => !present.has(relativePath)));
  const detail = changed.length ? `changed inputs: ${changed.join(', ')}` : 'artifact bytes or receipt format differ';
  throw new Error(`MARS bridge artifact is stale (${detail}). Run node scripts/build-mars-bridge.mjs and commit the jar and artifact-manifest.json.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkMarsBridge();
    console.log('MARS bridge artifact is current (Node-only check).');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
