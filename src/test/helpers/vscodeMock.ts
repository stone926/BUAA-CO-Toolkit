import * as path from 'path';
import { URI } from 'vscode-uri';
import type { Mock } from 'vitest';

type MockFactory = <T extends (...args: any[]) => any>(implementation?: T) => Mock<T>;

export interface VscodeMockDocument {
  uri: URI;
  languageId?: string;
  isDirty?: boolean;
  getText?: () => string;
  save?: Mock<() => Promise<boolean>>;
}

export interface VscodeMockState {
  activeTextEditor?: {
    document: VscodeMockDocument;
    selection?: { active: { line: number; character: number } };
  };
  textDocuments: VscodeMockDocument[];
  workspaceFolders: Array<{ uri: URI; name?: string }>;
  config: Map<string, unknown>;
}

export interface VscodeMockModule {
  Uri: typeof URI;
  RelativePattern: new (base: { uri: URI } | URI | string, pattern: string) => { base: unknown; pattern: string };
  ConfigurationTarget: { Workspace: number; Global: number; WorkspaceFolder: number };
  FileType: { Unknown: number; File: number; Directory: number; SymbolicLink: number };
  ViewColumn: { Beside: number };
  EventEmitter: new <T>() => {
    event: (listener: (value: T) => void) => { dispose: () => void };
    fire: (value: T) => void;
    dispose: () => void;
  };
  workspace: {
    isTrusted: boolean;
    textDocuments: VscodeMockDocument[];
    workspaceFolders: Array<{ uri: URI; name?: string }>;
    getWorkspaceFolder: (uri: URI) => { uri: URI; name?: string } | undefined;
    fs: {
      readFile: Mock<(uri: URI) => Promise<Uint8Array>>;
      writeFile: Mock<(uri: URI, bytes: Uint8Array) => Promise<void>>;
      createDirectory: Mock<(uri: URI) => Promise<void>>;
      stat: Mock<(uri: URI) => Promise<{ mtime: number; ctime: number; size: number; type: number }>>;
    };
    findFiles: Mock<(include: unknown, exclude?: unknown, maxResults?: number) => Promise<URI[]>>;
    saveAll: Mock<(includeUntitled?: boolean) => Promise<boolean>>;
    asRelativePath: Mock<(uri: URI | string) => string>;
    getConfiguration: Mock<(section?: string, resource?: unknown) => {
      get: <T>(key: string, defaultValue?: T) => T;
      inspect: <T>(key: string) => {
        key: string;
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
        globalLanguageValue?: T;
        workspaceLanguageValue?: T;
      };
      update: Mock<(key: string, value: unknown, target?: unknown) => Promise<void>>;
    }>;
  };
  window: {
    activeTextEditor?: VscodeMockState['activeTextEditor'];
    showQuickPick: Mock<(...args: any[]) => Promise<any>>;
    showOpenDialog: Mock<(...args: any[]) => Promise<URI[] | undefined>>;
    showInformationMessage: Mock<(...args: any[]) => Promise<any>>;
    showWarningMessage: Mock<(...args: any[]) => Promise<any>>;
    showErrorMessage: Mock<(...args: any[]) => Promise<any>>;
    showTextDocument: Mock<(...args: any[]) => Promise<any>>;
    createWebviewPanel: Mock<(...args: any[]) => { webview: { html: string }; dispose: Mock<() => void> }>;
  };
  commands: {
    registerCommand: Mock<(command: string, callback: (...args: any[]) => unknown) => { dispose: () => void }>;
    executeCommand: Mock<(...args: any[]) => Promise<unknown>>;
  };
}

export function createVscodeMockState(): VscodeMockState {
  return {
    textDocuments: [],
    workspaceFolders: [],
    config: new Map()
  };
}

export function createVscodeModuleMock(state: VscodeMockState, fn: MockFactory): VscodeMockModule {
  const configUpdates = new Map<string, Mock<(key: string, value: unknown, target?: unknown) => Promise<void>>>();
  const module = {
    Uri: URI,
    RelativePattern: class RelativePattern {
      constructor(public base: { uri: URI } | URI | string, public pattern: string) {}
    },
    ConfigurationTarget: { Workspace: 1, Global: 2, WorkspaceFolder: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ViewColumn: { Beside: 2 },
    EventEmitter: class EventEmitter<T> {
      private listeners = new Set<(value: T) => void>();
      event = (listener: (value: T) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
      fire(value: T): void {
        for (const listener of this.listeners) {
          listener(value);
        }
      }
      dispose(): void {
        this.listeners.clear();
      }
    },
    workspace: {
      isTrusted: true,
      get textDocuments() {
        return state.textDocuments;
      },
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      getWorkspaceFolder(uri: URI) {
        const normalized = path.resolve(uri.fsPath).toLowerCase();
        return state.workspaceFolders.find((item) => {
          const root = path.resolve(item.uri.fsPath).toLowerCase();
          return normalized === root || normalized.startsWith(`${root}${path.sep}`);
        });
      },
      fs: {
        readFile: fn(async () => new Uint8Array()),
        writeFile: fn(async () => undefined),
        createDirectory: fn(async () => undefined),
        stat: fn(async () => ({ mtime: Date.now(), ctime: Date.now(), size: 0, type: 1 }))
      },
      findFiles: fn(async () => []),
      saveAll: fn(async () => true),
      asRelativePath: fn((uri: URI | string) => {
        const fsPath = typeof uri === 'string' ? uri : uri.fsPath;
        const folder = state.workspaceFolders.find((item) => fsPath.startsWith(item.uri.fsPath));
        return folder ? path.relative(folder.uri.fsPath, fsPath).replace(/\\/g, '/') : path.basename(fsPath);
      }),
      getConfiguration: fn((section = '') => {
        let update: Mock<(key: string, value: unknown, target?: unknown) => Promise<void>> | undefined = configUpdates.get(section);
        if (!update) {
          update = fn(async (key: string, value: unknown) => {
            state.config.set(configKey(section, key), value);
          });
          configUpdates.set(section, update);
        }
        return {
          get<T>(key: string, defaultValue?: T): T {
            const value = state.config.get(configKey(section, key));
            return (value === undefined ? defaultValue : value) as T;
          },
          inspect<T>(key: string) {
            const value = state.config.get(configKey(section, key)) as T | undefined;
            return {
              key,
              defaultValue: undefined,
              globalValue: undefined,
              workspaceValue: value,
              workspaceFolderValue: undefined,
              globalLanguageValue: undefined,
              workspaceLanguageValue: undefined
            };
          },
          update
        };
      })
    },
    window: {
      get activeTextEditor() {
        return state.activeTextEditor;
      },
      set activeTextEditor(value: VscodeMockState['activeTextEditor']) {
        state.activeTextEditor = value;
      },
      showQuickPick: fn(async (items: unknown) => Array.isArray(items) ? items[0] : undefined),
      showOpenDialog: fn(async () => undefined),
      showInformationMessage: fn(async () => undefined),
      showWarningMessage: fn(async () => undefined),
      showErrorMessage: fn(async () => undefined),
      showTextDocument: fn(async () => undefined),
      createWebviewPanel: fn(() => ({ webview: { html: '' }, dispose: fn(() => undefined) }))
    },
    commands: {
      registerCommand: fn(() => ({ dispose: () => undefined })),
      executeCommand: fn(async () => undefined)
    }
  } satisfies VscodeMockModule;

  return module;
}

export function resetVscodeMockState(state: VscodeMockState): void {
  state.activeTextEditor = undefined;
  state.textDocuments.splice(0);
  state.workspaceFolders.splice(0);
  state.config.clear();
}

export function mockUri(filePath: string): URI {
  return URI.file(filePath);
}

export function mockDocument(filePath: string, languageId: string, text = ''): VscodeMockDocument {
  return {
    uri: mockUri(filePath),
    languageId,
    isDirty: false,
    getText: () => text,
    save: undefined
  };
}

function configKey(section: string, key: string): string {
  return section ? `${section}.${key}` : key;
}
