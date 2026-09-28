#!/usr/bin/env node
/**
 * Bundle browser-side webview code into out/media.
 *
 * The extension host is bundled separately; webviews run in a browser
 * sandbox and need one self-contained IIFE script plus its stylesheet. Shared pure
 * modules (waveform model/view logic, the MIPS decoder) are bundled from source.
 *
 * Usage: node scripts/build-webview.mjs [--dev]
 */
import * as esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--dev');

await esbuild.build({
  absWorkingDir: projectRoot,
  entryPoints: { waveform: 'src/waveform/webview/main.ts' },
  outdir: 'out/media',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  charset: 'utf8',
  legalComments: 'none',
  minify: !development,
  sourcemap: development ? 'linked' : false,
  tsconfig: 'tsconfig.webview.json',
  logLevel: 'warning'
});
