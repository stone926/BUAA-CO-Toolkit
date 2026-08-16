/**
 * Headless replacement for the `vscode` module used by the extracted course-testing
 * pipeline. It implements only the file/workspace/configuration surface required to run
 * the pipeline outside VS Code, while still presenting the full `vscode` module type so the
 * extracted plugin sources can be compiled unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';

type VscodeModule = typeof import('vscode');

interface ShimWorkspaceFolder {
  uri: URI;
  name: string;
  index: number;
}

const fileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64
} as const;

const state: {
  workspaceFolders: ShimWorkspaceFolder[];
  config: Map<string, unknown>;
} = {
  workspaceFolders: [],
  config: new Map()
};

function defaultConfigValues(): Record<string, unknown> {
  try {
    const defaultsPath = path.join(__dirname, '..', '..', 'resources', 'co', 'configDefaults.json');
    return JSON.parse(fs.readFileSync(defaultsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function loadDefaultConfig(): void {
  const defaults = defaultConfigValues();
  state.config.clear();
  for (const [key, value] of Object.entries(defaults)) {
    state.config.set(`co.${key}`, value);
  }
}

loadDefaultConfig();

export function configureHeadlessWorkspace(options: {
  workspaceRoot?: string;
  config?: Record<string, unknown>;
}): void {
  loadDefaultConfig();
  state.workspaceFolders = options.workspaceRoot
    ? [{
        uri: URI.file(path.resolve(options.workspaceRoot)),
        name: path.basename(path.resolve(options.workspaceRoot)),
        index: 0
      }]
    : [];
  for (const [key, value] of Object.entries(options.config ?? {})) {
    const normalized = key.startsWith('co.') ? key : `co.${key}`;
    state.config.set(normalized, value);
  }
}

export function headlessWorkspaceRoot(): string | undefined {
  return state.workspaceFolders[0]?.uri.fsPath;
}

class ShimRelativePattern {
  constructor(
    public readonly base: string | { uri: URI } | URI,
    public readonly pattern: string
  ) {}

  basePath(): string {
    if (typeof this.base === 'string') {
      return this.base;
    }
    if (this.base instanceof URI) {
      return this.base.fsPath;
    }
    return this.base.uri.fsPath;
  }
}

function slashPath(value: string): string {
  return value.split(String.fromCharCode(92)).join('/');
}

function expandBraces(glob: string): string {
  const match = /^([^{}]*)\{([^{}]*)\}(.*)$/.exec(glob);
  if (!match) {
    return glob;
  }
  const [, prefix, body, suffix] = match;
  return body.split(',').map((choice) => expandBraces(`${prefix}${choice}${suffix}`)).join('\u0000');
}

function globRegex(glob: string): RegExp {
  let pattern = '';
  const normalized = slashPath(glob).replace(/^\.\//, '');
  const alternatives = expandBraces(normalized).split('\u0000');
  for (const alternative of alternatives) {
    let partial = '^';
    for (let i = 0; i < alternative.length; i++) {
      const char = alternative[i];
      if (char === '*') {
        if (alternative[i + 1] === '*') {
          i++;
          if (alternative[i + 1] === '/') {
            i++;
            partial += '(?:.*/)?';
          } else {
            partial += '.*';
          }
        } else {
          partial += '[^/]*';
        }
        continue;
      }
      if (char === '?') {
        partial += '[^/]';
        continue;
      }
      partial += /[a-zA-Z0-9_.\-]/.test(char) ? char : String.fromCharCode(92) + char;
    }
    partial += '$';
    pattern += pattern ? `|${partial}` : partial;
  }
  return new RegExp(pattern, 'i');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function folderFor(uri?: URI): ShimWorkspaceFolder | undefined {
  if (uri) {
    return state.workspaceFolders.find((folder) => isInside(folder.uri.fsPath, uri.fsPath));
  }
  return state.workspaceFolders[0];
}

function defaultExcludePatterns(): string[] {
  return ['**/{.git,node_modules,.build-src,dist}/**'];
}

function shouldAlwaysSkip(relativePath: string): boolean {
  const parts = relativePath.split('/');
  return parts.some((part) => part === '.git' || part === 'node_modules' || part === '.build-src' || part === 'dist');
}

async function walkFiles(
  base: string,
  includeRegex: RegExp,
  excludeRegexes: RegExp[],
  maxResults: number,
  results: URI[]
): Promise<void> {
  if (results.length >= maxResults) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(base, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (results.length >= maxResults) {
      return;
    }
    const absolute = path.join(base, entry.name);
    const relative = slashPath(path.relative(basePathForCurrentWalk(), absolute));
    if (shouldAlwaysSkip(relative)) {
      continue;
    }
    if (excludeRegexes.some((regex) => regex.test(relative))) {
      continue;
    }
    if (entry.isDirectory()) {
      await walkFiles(absolute, includeRegex, excludeRegexes, maxResults, results);
    } else if (entry.isFile() && includeRegex.test(relative)) {
      results.push(URI.file(absolute));
    }
  }
}

let currentWalkBase = '';

function basePathForCurrentWalk(): string {
  return currentWalkBase || state.workspaceFolders[0]?.uri.fsPath || process.cwd();
}

function patternParts(include: unknown): { base: string; pattern: string } {
  if (include instanceof ShimRelativePattern) {
    return { base: include.basePath(), pattern: include.pattern };
  }
  if (include && typeof include === 'object' && 'base' in (include as Record<string, unknown>) && 'pattern' in (include as Record<string, unknown>)) {
    const value = include as { base: string | { uri: URI } | URI; pattern: string };
    const base = typeof value.base === 'string'
      ? value.base
      : value.base instanceof URI
        ? value.base.fsPath
        : value.base.uri.fsPath;
    return { base, pattern: value.pattern };
  }
  return { base: state.workspaceFolders[0]?.uri.fsPath ?? process.cwd(), pattern: String(include) };
}

function disposable(): { dispose: () => void } {
  return { dispose: () => undefined };
}

class ShimEventEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): { dispose: () => void } => {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

const workspaceFs = {
  async readFile(uri: URI): Promise<Uint8Array> {
    return await fs.promises.readFile(uri.fsPath);
  },
  async writeFile(uri: URI, content: Uint8Array): Promise<void> {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  },
  async createDirectory(uri: URI): Promise<void> {
    await fs.promises.mkdir(uri.fsPath, { recursive: true });
  },
  async delete(uri: URI, _options?: { recursive?: boolean; useTrash?: boolean }): Promise<void> {
    await fs.promises.rm(uri.fsPath, { recursive: true, force: true });
  },
  async stat(uri: URI): Promise<{ mtime: number; size: number; type: number }> {
    const value = await fs.promises.stat(uri.fsPath);
    return {
      mtime: value.mtimeMs,
      size: value.size,
      type: value.isDirectory() ? fileType.Directory : fileType.File
    };
  }
};

const workspaceApi = {
  get workspaceFolders(): ShimWorkspaceFolder[] | undefined {
    return state.workspaceFolders.length ? state.workspaceFolders : undefined;
  },
  textDocuments: [] as Array<unknown>,
  fs: workspaceFs,
  getWorkspaceFolder(uri?: URI): ShimWorkspaceFolder | undefined {
    return folderFor(uri);
  },
  async saveAll(_includeUntitled?: boolean): Promise<boolean> {
    return true;
  },
  asRelativePath(uri: URI | string): string {
    const fsPath = typeof uri === 'string' ? uri : uri.fsPath;
    const folder = folderFor(typeof uri === 'string' ? URI.file(uri) : uri) ?? state.workspaceFolders[0];
    if (!folder) {
      return path.basename(fsPath);
    }
    const relative = path.relative(folder.uri.fsPath, fsPath);
    return relative ? slashPath(relative) : path.basename(fsPath);
  },
  getConfiguration(section?: string, _resource?: URI) {
    const prefix = section ? `${section}.` : '';
    return {
      get<T>(key: string, defaultValue?: T): T {
        const value = state.config.get(`${prefix}${key}`);
        return value === undefined ? defaultValue as T : value as T;
      },
      inspect<T>(key: string) {
        const value = state.config.get(`${prefix}${key}`) as T | undefined;
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
      async update(key: string, value: unknown): Promise<void> {
        state.config.set(`${prefix}${key}`, value);
      }
    };
  },
  async findFiles(include: unknown, exclude?: string, maxResults = 200): Promise<URI[]> {
    const { base, pattern } = patternParts(include);
    const includeRegex = globRegex(pattern);
    const excludeGlobs = [exclude, ...defaultExcludePatterns()].filter((value): value is string => Boolean(value));
    const excludeRegexes = excludeGlobs.map((glob) => globRegex(glob));
    const results: URI[] = [];
    currentWalkBase = base;
    try {
      await walkFiles(base, includeRegex, excludeRegexes, maxResults, results);
    } finally {
      currentWalkBase = '';
    }
    return results;
  },
  createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: () => disposable(), onDidChange: () => disposable(), onDidDelete: () => disposable() }),
  onDidSaveTextDocument: () => disposable(),
  onDidChangeConfiguration: () => disposable()
};

const windowApi = {
  activeTextEditor: undefined as unknown,
  visibleTextEditors: [] as unknown[],
  showQuickPick: async <T>(_items: readonly T[] | Thenable<readonly T[]>): Promise<T | undefined> => undefined,
  showOpenDialog: async () => undefined,
  showInformationMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showTextDocument: async () => undefined,
  createOutputChannel: () => ({
    name: 'BUAA CO Test CLI',
    append: () => undefined,
    appendLine: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    replace: () => undefined,
    dispose: () => undefined
  }),
  createWebviewPanel: () => ({
    webview: { html: '' },
    title: '',
    viewType: '',
    active: false,
    visible: false,
    options: {},
    onDidDispose: () => disposable(),
    onDidChangeViewState: () => disposable(),
    reveal: () => undefined,
    dispose: () => undefined
  }),
  createStatusBarItem: () => ({
    text: '',
    tooltip: undefined,
    command: undefined,
    color: undefined,
    backgroundColor: undefined,
    alignment: 0,
    priority: undefined,
    name: undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined
  }),
  createTerminal: () => ({
    name: '',
    processId: undefined,
    creationOptions: {},
    exitStatus: undefined,
    sendText: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined
  }),
  registerTreeDataProvider: () => disposable()
};

const commandsApi = {
  registerCommand: () => disposable(),
  executeCommand: async <T>(_command: string, ..._args: unknown[]): Promise<T | undefined> => undefined
};

const vscode = {
  Uri: URI,
  RelativePattern: ShimRelativePattern,
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  FileType: fileType,
  EventEmitter: ShimEventEmitter,
  workspace: workspaceApi,
  window: windowApi,
  commands: commandsApi,
  env: {
    appName: 'BUAA CO Test CLI',
    appRoot: '',
    language: 'en',
    machineId: 'headless',
    remoteName: undefined,
    sessionId: 'headless',
    shell: process.env.COMSPEC ?? process.env.SHELL ?? '',
    uriScheme: 'file',
    clipboard: { readText: async () => '', writeText: async () => undefined },
    openExternal: async () => false
  },
  extensions: {
    all: [],
    getExtension: () => undefined
  },
  version: '1.90.0-headless'
} as unknown as VscodeModule;


export const Uri = vscode.Uri;
export const RelativePattern = vscode.RelativePattern;
export const ConfigurationTarget = vscode.ConfigurationTarget;
export const ViewColumn = vscode.ViewColumn;
export const StatusBarAlignment = vscode.StatusBarAlignment;
export const FileType = vscode.FileType;
export const EventEmitter = vscode.EventEmitter;
export { workspaceApi as workspace };
export { windowApi as window };
export { commandsApi as commands };
export const env = vscode.env;
export const extensions = vscode.extensions;
export const version = vscode.version;
