#!/usr/bin/env node
// Launch the packaged extension in a real, isolated VS Code development host.
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

if (process.argv.length !== 3) {
  throw new Error('Usage: node scripts/verify-extension-host.mjs <unpacked-extension-root>');
}

const extensionRoot = resolve(process.argv[2]);
const logRoot = resolve('.vscode-test/extension-host-smoke');
await mkdir(logRoot, { recursive: true });
const sessionRoot = await mkdtemp(join(logRoot, 'run-'));
const workspace = join(sessionRoot, '课程 workspace');
// VS Code's IPC socket must fit macOS's Unix socket path limit.
const userData = await mkdtemp(join(tmpdir(), 'co-vscode-'));
await mkdir(workspace);
await mkdir(join(userData, 'User'), { recursive: true });
await writeFile(join(userData, 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off',
  'workbench.startupEditor': 'none',
  'files.autoSave': 'off'
}));

console.log(`VS Code smoke workspace and logs: ${sessionRoot}`);
try {
  await runTests({
    version: process.env.CO_VSCODE_VERSION || 'stable',
    extensionDevelopmentPath: extensionRoot,
    extensionTestsPath: fileURLToPath(new URL('./extension-host-smoke.cjs', import.meta.url)),
    extensionTestsEnv: {
      CO_EXTENSION_ROOT: extensionRoot,
      ELECTRON_RUN_AS_NODE: undefined
    },
    launchArgs: [
      workspace,
      '--user-data-dir', userData,
      '--extensions-dir', join(sessionRoot, 'extensions'),
      '--disable-extensions',
      '--disable-gpu'
    ]
  });
} catch (error) {
  console.error(`Extension host smoke failed; logs are in ${sessionRoot}/logs`);
  console.error(error);
  process.exitCode = 1;
} finally {
  await cp(join(userData, 'logs'), join(sessionRoot, 'logs'), { recursive: true }).catch((error) => {
    // VS Code may fail to launch before creating any logs.
    if (error.code !== 'ENOENT') throw error;
  });
}
