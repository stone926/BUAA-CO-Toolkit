/** Run versioned JSONL requests through the compiled production CLI boundary. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerRoot = path.dirname(fileURLToPath(import.meta.url));
export const extensionRoot = path.resolve(runnerRoot, '..', '..', '..');
const defaultCli = path.join(extensionRoot, 'out', 'mips', 'cli', 'main.js');

export function invokeTsCli(requests, options = {}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('TS CLI request batch must be a non-empty array');
  }
  const cli = path.resolve(options.cli ?? process.env.BUAA_CO_MIPS_ENGINE_CLI ?? defaultCli);
  if (!fs.statSync(cli, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`compiled TS CLI is missing: ${cli}`);
  }
  const run = spawnSync(process.execPath, [cli], {
    cwd: extensionRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`TS CLI exited ${run.status}: ${(run.stderr ?? '').slice(0, 1000)}`);
  }
  const responses = run.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  if (responses.length !== requests.length) {
    throw new Error(`TS CLI returned ${responses.length} responses for ${requests.length} requests`);
  }
  const byId = new Map(responses.map((response) => [response.requestId, response]));
  if (byId.size !== responses.length || responses.some((response) => response.protocolVersion !== 1)) {
    throw new Error('TS CLI returned duplicate IDs or an unsupported protocol response');
  }
  return byId;
}
