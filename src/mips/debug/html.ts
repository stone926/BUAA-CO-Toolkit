// @index mips-debug — Strict CSP shell for the internal MARS workbench browser bundle
import { escapeHtml } from '../../language/common/util';

export interface MarsWorkbenchHtmlOptions {
  scriptUri: string;
  styleUri: string;
  cspSource: string;
  nonce: string;
}

export function buildMarsWorkbenchHtml(options: MarsWorkbenchHtmlOptions): string {
  const { scriptUri, styleUri, cspSource, nonce } = options;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(cspSource)}; script-src 'nonce-${escapeHtml(nonce)}'; font-src ${escapeHtml(cspSource)};">
  <link rel="stylesheet" href="${escapeHtml(styleUri)}">
  <title>MARS 工作台</title>
</head>
<body><div id="app"><p class="loading">正在连接 MARS 工作台…</p></div>
<script nonce="${escapeHtml(nonce)}" src="${escapeHtml(scriptUri)}"></script>
</body></html>`;
}
