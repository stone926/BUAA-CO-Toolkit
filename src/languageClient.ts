// @index lsp-client — 启动/停止IPC模式Language Server
import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';
import { StartupTraceOutput, timeStartup, traceStartup } from './startupTrace';
import { languageDocumentSelector, languageFileGlob } from './language/languageRegistry';

let client: LanguageClient | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let startupOutput: StartupTraceOutput | undefined;
let startPromise: Promise<void> | undefined;
let openListener: vscode.Disposable | undefined;

/** Start the LSP when an eligible document opens or an LSP command runs. */
export function startLanguageServer(context: vscode.ExtensionContext, output?: StartupTraceOutput): void {
  extensionContext = context;
  startupOutput = output;
  openListener?.dispose();
  let listener: vscode.Disposable;
  const disposeAfterStart = (): void => {
    if (openListener === listener) {
      listener.dispose();
      openListener = undefined;
    }
  };
  listener = vscode.workspace.onDidOpenTextDocument((document) => {
    if (isLanguageDocument(document)) {
      void ensureLanguageClient().then(disposeAfterStart, () => undefined);
    }
  });
  openListener = listener;
  context.subscriptions.push(listener);
  if (vscode.workspace.textDocuments.some(isLanguageDocument)) {
    void ensureLanguageClient().then(disposeAfterStart, () => undefined);
  }
}

function isLanguageDocument(document: vscode.TextDocument): boolean {
  return vscode.languages.match(languageDocumentSelector(), document) > 0;
}

export function ensureLanguageClient(): Promise<void> {
  if (startPromise) {
    return startPromise;
  }
  const context = extensionContext;
  if (!context) {
    return Promise.reject(new Error('Language client requested before extension activation'));
  }
  const output = startupOutput;
  const finishStartTrace = timeStartup('language client start', output);
  traceStartup('language client start requested', output);
  const serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ['--nolazy', '--inspect=6009']
      }
    }
  };
  const watcher = vscode.workspace.createFileSystemWatcher(languageFileGlob());
  context.subscriptions.push(watcher);
  const clientOptions: LanguageClientOptions = {
    documentSelector: languageDocumentSelector(),
    synchronize: {
      configurationSection: 'co',
      fileEvents: watcher
    },
    initializationOptions: {
      extensionRoot: context.extensionUri.fsPath
    }
  };

  const current = new LanguageClient('buaa-co-language-server', 'BUAA CO Toolkit LSP', serverOptions, clientOptions);
  client = current;
  context.subscriptions.push(current);
  startPromise = current.start().then(
    () => { finishStartTrace(); },
    (error) => {
      traceStartup(`language client start failed: ${error instanceof Error ? error.message : String(error)}`, output);
      watcher.dispose();
      if (client === current) {
        client = undefined;
        startPromise = undefined;
      }
      throw error;
    }
  );
  return startPromise;
}

export async function stopLanguageServer(): Promise<void> {
  extensionContext = undefined;
  startupOutput = undefined;
  openListener?.dispose();
  openListener = undefined;
  const current = client;
  const pending = startPromise;
  client = undefined;
  startPromise = undefined;
  if (!current) return;
  let started = true;
  try {
    await pending;
  } catch {
    started = false;
  }
  if (started) await current.stop();
}

export async function executeLanguageServerCommand(command: string, args: unknown[] = []): Promise<unknown> {
  await ensureLanguageClient();
  if (!client) throw new Error('Language client stopped before command execution');
  return await client.sendRequest('workspace/executeCommand', {
    command,
    arguments: args
  });
}
