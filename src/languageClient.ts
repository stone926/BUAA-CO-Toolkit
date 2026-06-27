// @index lsp-client — 启动/停止IPC模式Language Server
import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function startLanguageServer(context: vscode.ExtensionContext): void {
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
  void client.start();
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
