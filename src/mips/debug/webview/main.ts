// @index mips-debug — Browser bundle entry and typed VS Code webview channel
import './styles.css';
import { WorkbenchApp } from './app';
import type { WorkbenchRequest } from '../protocol';

declare function acquireVsCodeApi(): { postMessage(message: WorkbenchRequest): void };
const root = document.getElementById('app');
if (root) {
  const vscode = acquireVsCodeApi();
  new WorkbenchApp(root, request => vscode.postMessage(request));
}
