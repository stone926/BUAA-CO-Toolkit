import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptsDirectory, '..');
const outputDirectory = path.resolve(projectRoot, 'out');

if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== 'out') {
  throw new Error(`Refusing to clean unexpected compile output: ${outputDirectory}`);
}

await rm(outputDirectory, { recursive: true, force: true });
