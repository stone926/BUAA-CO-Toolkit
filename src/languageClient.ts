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

let client: LanguageClient | undefined;

export function startLanguageServer(context: vscode.ExtensionContext, output?: StartupTraceOutput): void {
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
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'mipsasm' },
      { scheme: 'file', language: 'verilog' },
      { scheme: 'file', pattern: '**/*.circ' }
    ],
    synchronize: {
      configurationSection: 'co',
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.{v,asm,s,mips}')
    }
  };

  client = new LanguageClient('buaa-co-language-server', 'BUAA CO Toolkit LSP', serverOptions, clientOptions);
  context.subscriptions.push(client);
  void client.start().then(
    () => finishStartTrace(),
    (error) => {
      traceStartup(`language client start failed: ${error instanceof Error ? error.message : String(error)}`, output);
    }
  );
}

export async function stopLanguageServer(): Promise<void> {
  if (!client) {
    return;
  }
  const current = client;
  client = undefined;
  await current.stop();
}

export async function executeLanguageServerCommand(command: string, args: unknown[] = []): Promise<unknown> {
  if (!client) {
    return undefined;
  }
  await client.start();
  return await client.sendRequest('workspace/executeCommand', {
    command,
    arguments: args
  });
}
