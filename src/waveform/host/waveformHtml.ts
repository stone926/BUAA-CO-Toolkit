// @index waveform-html — 波形 Webview 页面：严格 CSP（nonce 脚本、仅扩展资源）、打包脚本/样式 URI 与标题转义

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { escapeHtml } from '../../language/common/util';
import { renderResourceTemplate } from '../../templates/templateRegistry';

/** Bundled browser assets produced by scripts/build-webview.mjs (never tsc output). */
export function waveformAssetRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'out', 'media');
}

export function buildWaveformHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const assets = waveformAssetRoot(extensionUri);
  return renderResourceTemplate('webview/waveform_page.html', {
    cspSource: webview.cspSource,
    nonce: randomBytes(18).toString('base64'),
    scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'waveform.js')).toString(),
    styleUri: webview.asWebviewUri(vscode.Uri.joinPath(assets, 'waveform.css')).toString(),
    title: escapeHtml(title)
  });
}
