import { Commands } from './constants';
// @index lsp-server — 协议路由、验证调度、跨文件索引管理
import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  CompletionItem,
  CompletionParams,
  createConnection,
  DefinitionParams,
  Diagnostic,
  DocumentFormattingParams,
  DocumentFormattingRequest,
  DocumentSymbolParams,
  DocumentSymbol,
  FileChangeType,
  FileEvent,
  FoldingRange,
  FoldingRangeParams,
  FormattingOptions,
  Hover,
  HoverParams,
  InlayHint,
  InlayHintParams,
  InitializeParams,
  InitializeResult,
  Location,
  Position,
  PrepareRenameParams,
  ProposedFeatures,
  Range,
  ReferenceParams,
  RenameParams,
  SemanticTokens,
  SemanticTokensParams,
  SignatureHelp,
  SignatureHelpParams,
  TextEdit,
  TextDocumentSyncKind,
  TextDocuments,
  WorkspaceEdit,
  WorkspaceFolder
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { defaultCoSettings, mergeCoSettings, CoSettings } from './language/common/settings';
import { applyResolvedProfile, ProfileResolverInput } from './profileResolver';
import {
  filterDisabledDiagnostics,
  getDiagnosticSuppressActions
} from './language/common/diagnosticActions';
import {
  getLogisimDiagnostics,
  getLogisimDocumentSymbols,
  getLogisimHover
} from './language/logisim/service';
import {
  getMipsCodeActions,
  getMipsCompletions,
  getMipsDefinition,
  getMipsDiagnostics,
  getMipsDocumentSymbols,
  getMipsFoldingRanges,
  getMipsFormattingEdits,
  getMipsHover,
  getMipsInlayHints,
  getMipsReferences,
  getMipsRenameEdits,
  getMipsRenamePrepare,
  getMipsSemanticTokens,
  getMipsSignatureHelp,
  clearMipsSemanticTokenCache,
  clearMipsParseCache,
  mipsIgnorePseudoFileCommand,
  mipsIgnorePseudoMnemonicCommand,
  MipsServerState
} from './language/mips/service';
import { mipsSemanticTokenTypes } from './language/mips/resources';
import {
  getVerilogCodeActions,
  getVerilogCompletions,
  getVerilogDefinition,
  getVerilogDiagnostics,
  getVerilogDocumentSymbols,
  getVerilogFoldingRanges,
  getVerilogFormattingEdits,
  getVerilogHover,
  getVerilogInlayHints,
  getVerilogReferences,
  getVerilogRenameEdits,
  getVerilogRenamePrepare,
  getVerilogSemanticTokens,
  getVerilogSignatureHelp
} from './language/verilog/service';
import { runExternalVerilogSyntaxCheck as executeExternalVerilogSyntaxCheck } from './language/verilog/externalSyntaxCheck';
import { verilogSemanticTokenTypes } from './language/verilog/model';
import { isVerilogUri, VerilogWorkspaceIndex } from './language/verilog/workspaceIndex';
import { extractVerilogDisplayFormats } from './language/verilog/displayFormats';
import { samePath } from './pathUtils';
import { startupTraceEnabled, timeStartup, traceStartup } from './startupTrace';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const verilogIndex = new VerilogWorkspaceIndex({ workspaceComplete: false });
const logisimLanguageId = 'logisim-circ';
const mipsState: MipsServerState = {
  ignoredPseudoInstructionFiles: new Set(),
  ignoredPseudoInstructionMnemonics: new Set()
};

interface CoLanguageService {
  getDiagnostics?: (document: TextDocument, settings: CoSettings) => Diagnostic[];
  getCompletions?: (document: TextDocument, position: Position, settings: CoSettings) => CompletionItem[];
  getHover?: (document: TextDocument, position: Position, settings: CoSettings) => Hover | undefined;
  getDefinition?: (document: TextDocument, position: Position, settings: CoSettings) => Location | undefined;
  getReferences?: (document: TextDocument, params: ReferenceParams, settings: CoSettings) => Location[];
  getDocumentSymbols?: (document: TextDocument, settings: CoSettings) => DocumentSymbol[];
  getCodeActions?: (document: TextDocument, range: Range, diagnostics: Diagnostic[], settings: CoSettings) => CodeAction[];
  getFormattingEdits?: (document: TextDocument, settings: CoSettings, options: FormattingOptions) => TextEdit[];
  getInlayHints?: (document: TextDocument, range: Range, settings: CoSettings) => InlayHint[];
  getSemanticTokens?: (document: TextDocument, settings: CoSettings) => SemanticTokens;
  getFoldingRanges?: (document: TextDocument, settings: CoSettings) => FoldingRange[];
  getSignatureHelp?: (document: TextDocument, position: Position, settings: CoSettings) => SignatureHelp | undefined;
  getRenameEdits?: (document: TextDocument, position: Position, newName: string, settings: CoSettings) => WorkspaceEdit | undefined;
  getRenamePrepare?: (document: TextDocument, position: Position, settings: CoSettings) => Range | undefined;
  updateDocument?: (document: TextDocument, settings: CoSettings) => void;
  removeDocument?: (uri: string, settings: CoSettings) => void | Promise<void>;
}

const languageServices = new Map<string, CoLanguageService>([
  ['mipsasm', {
    getDiagnostics: (document, settings) => getMipsDiagnostics(document, settings, mipsState),
    getCompletions: (document, position, settings) => getMipsCompletions(document, position, settings, mipsState),
    getHover: (document, position, settings) => getMipsHover(document, position, settings, mipsState),
    getDefinition: (document, position, settings) => getMipsDefinition(document, position, settings, mipsState),
    getReferences: (document, params, settings) => getMipsReferences(document, params, settings, mipsState),
    getDocumentSymbols: (document, settings) => getMipsDocumentSymbols(document, settings, mipsState),
    getCodeActions: (document, _range, diagnostics) => getMipsCodeActions(document, diagnostics),
    getFormattingEdits: (document) => getMipsFormattingEdits(document),
    getInlayHints: (document, range, settings) => getMipsInlayHints(document, range, settings, mipsState),
    getSemanticTokens: (document, settings) => getMipsSemanticTokens(document, settings, mipsState),
    getFoldingRanges: (document, settings) => getMipsFoldingRanges(document, settings, mipsState),
    getSignatureHelp: (document, position, settings) => getMipsSignatureHelp(document, position, settings, mipsState),
    getRenameEdits: (document, position, newName, settings) => getMipsRenameEdits(document, position, newName, settings, mipsState),
    getRenamePrepare: (document, position, settings) => getMipsRenamePrepare(document, position, settings, mipsState),
    removeDocument: clearMipsParseCache
  }],
  ['verilog', {
    getDiagnostics: (document, settings) => getVerilogDiagnostics(document, settings, verilogIndex),
    getCompletions: (document, position, settings) => getVerilogCompletions(document, position, settings, verilogIndex),
    getHover: (document, position, settings) => getVerilogHover(document, position, settings, verilogIndex),
    getDefinition: (document, position, settings) => getVerilogDefinition(document, position, settings, verilogIndex),
    getReferences: (document, params, settings) => getVerilogReferences(document, params, settings, verilogIndex),
    getDocumentSymbols: getVerilogDocumentSymbols,
    getCodeActions: (document, range, diagnostics, settings) => getVerilogCodeActions(document, range, diagnostics, settings, verilogIndex),
    getFormattingEdits: (document, settings, options) => getVerilogFormattingEdits(document, settings, options),
    getInlayHints: (document, range, settings) => getVerilogInlayHints(document, range, settings, verilogIndex),
    getSemanticTokens: (document, settings) => getVerilogSemanticTokens(document, settings),
    getFoldingRanges: getVerilogFoldingRanges,
    getSignatureHelp: (document, position, settings) => getVerilogSignatureHelp(document, position, settings, verilogIndex),
    getRenameEdits: (document, position, newName, settings) => getVerilogRenameEdits(document, position, newName, settings, verilogIndex),
    getRenamePrepare: (document, position, settings) => getVerilogRenamePrepare(document, position, settings, verilogIndex),
    updateDocument: (document, settings) => verilogIndex.updateDocument(document, settings),
    removeDocument: closeVerilogDocument
  }],
  [logisimLanguageId, {
    getDiagnostics: (document) => getLogisimDiagnostics(document),
    getHover: (document, position) => getLogisimHover(document, position),
    getDocumentSymbols: (document) => getLogisimDocumentSymbols(document)
  }]
]);

interface ServerState {
  hasConfigurationCapability: boolean;
  hasFormattingDynamicRegistration: boolean;
  hasSemanticTokensRefreshSupport: boolean;
  workspaceFolders: WorkspaceFolder[] | null | undefined;
  extensionRoot?: string;
  globalSettings: CoSettings;
  documentSettings: Map<string, Thenable<CoSettings>>;
  updatedDocumentVersions: Map<string, number>;
  contentChangeTimers: Map<string, ReturnType<typeof setTimeout>>;
  verilogExternalDiagnostics: Map<string, Diagnostic[]>;
  verilogExternalTimers: Map<string, ReturnType<typeof setTimeout>>;
  verilogExternalControllers: Map<string, AbortController>;
  verilogExternalRunSequences: Map<string, number>;
  notifiedExternalToolchainError?: string;
  configurationVersion: number;
  effectiveSettingsCache: Map<string, CoSettings>;
  verilogProfileSnapshot?: VerilogProfileSnapshot;
}

interface VerilogProfileSnapshot {
  indexVersion: number;
  files: Array<{ path: string; languageId?: string }>;
  modules: NonNullable<ProfileResolverInput['modules']>;
  verilogDisplayFormatsByUri: Map<string, string[]>;
}

const state: ServerState = {
  hasConfigurationCapability: false,
  hasFormattingDynamicRegistration: false,
  hasSemanticTokensRefreshSupport: false,
  workspaceFolders: undefined,
  extensionRoot: undefined,
  globalSettings: defaultCoSettings,
  documentSettings: new Map(),
  updatedDocumentVersions: new Map(),
  contentChangeTimers: new Map(),
  verilogExternalDiagnostics: new Map(),
  verilogExternalTimers: new Map(),
  verilogExternalControllers: new Map(),
  verilogExternalRunSequences: new Map(),
  configurationVersion: 0,
  effectiveSettingsCache: new Map()
};
const verilogExternalSyntaxCommand = Commands.Server.InternalVerilogCheckSyntaxWithIse;
const maxEffectiveSettingsCacheEntries = 200;
const verilogIndexStartupDelayMs = 750;
let verilogIndexRebuildTimer: ReturnType<typeof setTimeout> | undefined;
let tracedFirstSemanticTokens = false;

function traceServerStartup(message: string): void {
  if (!startupTraceEnabled()) {
    return;
  }
  traceStartup(message);
  connection.console.info(`[BUAA CO Toolkit] ${message}`);
}

function extensionRootFromInitializationOptions(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const extensionRoot = (value as Record<string, unknown>).extensionRoot;
  return typeof extensionRoot === 'string' && extensionRoot.trim()
    ? extensionRoot.trim()
    : undefined;
}

function resetExternalVerilogSyntaxChecks(): void {
  for (const timer of state.verilogExternalTimers.values()) {
    clearTimeout(timer);
  }
  state.verilogExternalTimers.clear();
  for (const controller of state.verilogExternalControllers.values()) {
    controller.abort();
  }
  state.verilogExternalControllers.clear();
  state.verilogExternalDiagnostics.clear();
  state.verilogExternalRunSequences.clear();
  state.notifiedExternalToolchainError = undefined;
}

function logExternalSyntaxFailure(backend: string, output: string): void {
  const trimmed = output.trim();
  if (!trimmed) {
    return;
  }
  const maxLogCharacters = 32768;
  const suffix = trimmed.length > maxLogCharacters ? '\n… output truncated' : '';
  connection.console.error(
    `[BUAA CO Toolkit] ${backend} syntax check failed:\n${trimmed.slice(0, maxLogCharacters)}${suffix}`
  );
}

function clearExternalDiagnosticsForWorkspace(uri: string): void {
  const key = workspaceKeyForUri(uri);
  for (const diagnosticUri of state.verilogExternalDiagnostics.keys()) {
    if (workspaceKeyForUri(diagnosticUri) === key) {
      state.verilogExternalDiagnostics.delete(diagnosticUri);
    }
  }
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  traceServerStartup('server initialize begin');
  state.hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
  state.hasFormattingDynamicRegistration = Boolean(params.capabilities.textDocument?.formatting?.dynamicRegistration);
  state.hasSemanticTokensRefreshSupport = Boolean(params.capabilities.workspace?.semanticTokens?.refreshSupport);
  state.workspaceFolders = params.workspaceFolders;
  state.extensionRoot = extensionRootFromInitializationOptions(params.initializationOptions);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: ['$', '.', '%', '`']
      },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      documentSymbolProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorRewrite]
      },
      foldingRangeProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ['(', ',', ' '],
        retriggerCharacters: [',']
      },
      renameProvider: {
        prepareProvider: true
      },
      inlayHintProvider: true,
      executeCommandProvider: {
        commands: [mipsIgnorePseudoFileCommand, mipsIgnorePseudoMnemonicCommand, verilogExternalSyntaxCommand]
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...mipsSemanticTokenTypes, ...verilogSemanticTokenTypes],
          tokenModifiers: ['declaration']
        },
        full: true
      }
    },
    serverInfo: {
      name: 'BUAA CO Toolkit LSP'
    }
  };
});

connection.onInitialized(() => {
  traceServerStartup('server initialized');
  if (state.hasFormattingDynamicRegistration) {
    void connection.client.register(DocumentFormattingRequest.type, {
      documentSelector: [
        { scheme: 'file', language: 'mipsasm' },
        { scheme: 'file', language: 'verilog' }
      ]
    });
  }
  scheduleVerilogIndexRebuild(verilogIndexStartupDelayMs);
});

connection.onDidChangeConfiguration((change) => {
  if (state.hasConfigurationCapability) {
    state.documentSettings.clear();
  } else {
    state.globalSettings = mergeCoSettings(change.settings?.co);
  }
  state.configurationVersion++;
  state.effectiveSettingsCache.clear();
  state.verilogProfileSnapshot = undefined;
  clearMipsSemanticTokenCache();
  resetExternalVerilogSyntaxChecks();
  refreshSemanticTokens();
  void validateAllDocuments();
});

connection.onDidChangeWatchedFiles((params) => {
  void handleWatchedFilesChanged(params.changes).then((languageIds) => {
    return languageIds.has('*')
      ? validateAllDocuments()
      : validateDocuments((document) => languageIds.has(document.languageId));
  });
});

documents.onDidOpen((event) => {
  void updateIndexAndValidate(event.document);
});

// 防抖：快速连续输入时合并为一次解析+验证，避免每次按键都重新计算
documents.onDidChangeContent((event) => {
  const existing = state.contentChangeTimers.get(event.document.uri);
  if (existing) {
    clearTimeout(existing);
  }
  state.contentChangeTimers.set(event.document.uri, setTimeout(() => {
    state.contentChangeTimers.delete(event.document.uri);
    void updateIndexAndValidate(event.document);
  }, 250));
});

documents.onDidSave((event) => {
  void handleDocumentSaved(event.document);
});

documents.onDidClose((event) => {
  void handleDocumentClosed(event.document);
});

async function handleDocumentClosed(document: TextDocument): Promise<void> {
  const timer = state.contentChangeTimers.get(document.uri);
  if (timer) {
    clearTimeout(timer);
    state.contentChangeTimers.delete(document.uri);
  }
  const settings = await getDocumentSettings(document.uri);
  state.documentSettings.delete(document.uri);
  state.updatedDocumentVersions.delete(document.uri);
  state.verilogExternalDiagnostics.delete(document.uri);
  await serviceForDocument(document)?.removeDocument?.(document.uri, settings);
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: []
  });
  if (document.languageId === 'verilog') {
    await validateOpenVerilogDocuments();
  }
}

async function closeVerilogDocument(uri: string, settings: CoSettings): Promise<void> {
  if (isWorkspaceVerilogUri(uri)) {
    await verilogIndex.closeDocument(uri, settings);
  } else {
    verilogIndex.remove(uri);
  }
}

interface DocumentRequestParams {
  textDocument: {
    uri: string;
  };
}

function withDocument<P extends DocumentRequestParams, R>(
  handler: (doc: TextDocument, params: P, settings: CoSettings, svc: CoLanguageService) => R | undefined,
  fallback: R,
  options: { traceName?: string; firstOnly?: boolean } = {}
): (params: P) => Promise<R> {
  return async (params) => {
    const startedAt = startupTraceEnabled() && options.traceName ? Date.now() : undefined;
    let document: TextDocument | undefined;
    try {
      document = documents.get(params.textDocument.uri);
      if (!document) return fallback;
      const settings = effectiveSettingsForDocument(document, await getDocumentSettings(document.uri));
      const svc = serviceForDocument(document);
      return svc ? (handler(document, params, settings, svc) ?? fallback) : fallback;
    } catch (e) {
      connection.console.error(`[BUAA CO Toolkit] 处理程序错误: ${e}`);
      return fallback;
    } finally {
      if (startedAt !== undefined && options.traceName) {
        const shouldTrace = !options.firstOnly || !tracedFirstSemanticTokens;
        if (shouldTrace) {
          if (options.firstOnly) {
            tracedFirstSemanticTokens = true;
          }
          traceServerStartup(`${options.traceName} ${document?.languageId ?? 'unknown'} completed in ${Date.now() - startedAt}ms`);
        }
      }
    }
  };
}

connection.onCompletion(withDocument(
  (doc, params: CompletionParams, _settings, svc) => svc.getCompletions?.(doc, params.position, _settings), [] as CompletionItem[]
));

connection.onHover(withDocument(
  (doc, params: HoverParams, settings, svc) => svc.getHover?.(doc, params.position, settings), undefined as Hover | undefined
));

connection.onDefinition(withDocument(
  (doc, params: DefinitionParams, settings, svc) => svc.getDefinition?.(doc, params.position, settings), undefined as Location | undefined
));

connection.onReferences(withDocument(
  (doc, params: ReferenceParams, settings, svc) => svc.getReferences?.(doc, params, settings), [] as Location[]
));

connection.onDocumentSymbol(withDocument(
  (doc, _params: DocumentSymbolParams, settings, svc) => svc.getDocumentSymbols?.(doc, settings), [] as DocumentSymbol[]
));

connection.onCodeAction(withDocument(
  (doc, params: CodeActionParams, settings, svc) => getCodeActions(doc, params.range, params.context.diagnostics, settings, svc), [] as CodeAction[]
));

connection.onDocumentFormatting(withDocument(
  (doc, params: DocumentFormattingParams, settings, svc) => svc.getFormattingEdits?.(doc, settings, params.options), [] as TextEdit[]
));

connection.languages.inlayHint.on(withDocument(
  (doc, params: InlayHintParams, settings, svc) => svc.getInlayHints?.(doc, params.range, settings), [] as InlayHint[]
));

connection.languages.semanticTokens.on(withDocument(
  (doc, _params: SemanticTokensParams, settings, svc) => svc.getSemanticTokens?.(doc, settings),
  { data: [] } as SemanticTokens,
  { traceName: 'first semantic tokens', firstOnly: true }
));

connection.onFoldingRanges(withDocument(
  (doc, _params: FoldingRangeParams, settings, svc) => svc.getFoldingRanges?.(doc, settings), [] as FoldingRange[]
));

connection.onSignatureHelp(withDocument(
  (doc, params: SignatureHelpParams, settings, svc) => svc.getSignatureHelp?.(doc, params.position, settings), undefined as SignatureHelp | undefined
));

connection.onRenameRequest(withDocument(
  (doc, params: RenameParams, settings, svc) => svc.getRenameEdits?.(doc, params.position, params.newName, settings), undefined as WorkspaceEdit | undefined
));

connection.onPrepareRename(withDocument(
  (doc, params: PrepareRenameParams, settings, svc) => svc.getRenamePrepare?.(doc, params.position, settings), undefined as Range | undefined
));

connection.onExecuteCommand(async (params) => {
  if (params.command === mipsIgnorePseudoFileCommand && typeof params.arguments?.[0] === 'string') {
    mipsState.ignoredPseudoInstructionFiles.add(params.arguments[0]);
    await validateDocuments(isMipsDocument);
  } else if (params.command === mipsIgnorePseudoMnemonicCommand && typeof params.arguments?.[0] === 'string') {
    mipsState.ignoredPseudoInstructionMnemonics.add(params.arguments[0].toLowerCase());
    await validateDocuments(isMipsDocument);
  } else if (params.command === verilogExternalSyntaxCommand) {
    const uri = typeof params.arguments?.[0] === 'string'
      ? params.arguments[0]
      : documents.all().find((document) => document.languageId === 'verilog')?.uri;
    if (uri) {
      await runExternalVerilogSyntaxCheck(uri, await settingsForUri(uri), true);
    }
  }
});

async function handleDocumentSaved(document: TextDocument): Promise<void> {
  if (state.updatedDocumentVersions.get(document.uri) !== document.version) {
    await updateIndexAndValidate(document);
  }
  const settings = effectiveSettingsForDocument(document, await getDocumentSettings(document.uri));
  scheduleExternalVerilogSyntaxCheck(document, settings);
}

async function updateIndexAndValidate(document: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(document.uri);
  serviceForDocument(document)?.updateDocument?.(document, settings);
  await validateDocument(document, settings);
  state.updatedDocumentVersions.set(document.uri, document.version);
}

async function validateDocument(document: TextDocument, settings?: CoSettings): Promise<void> {
  const finishTrace = startupTraceEnabled()
    ? timeStartup(`diagnostics ${document.languageId} ${document.uri}`)
    : undefined;
  const resolvedSettings = effectiveSettingsForDocument(document, settings ?? await getDocumentSettings(document.uri));
  const diagnosticLanguageId = serviceKeyForDocument(document);
  const serviceDiagnostics = serviceForDocument(document)?.getDiagnostics?.(document, resolvedSettings) ?? [];
  const diagnostics = filterDisabledDiagnostics(
    diagnosticLanguageId,
    mergeExternalDiagnostics(document, serviceDiagnostics),
    resolvedSettings,
    document.uri
  );
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics
  });
  finishTrace?.();
}

function mergeExternalDiagnostics(document: TextDocument, diagnostics: Diagnostic[]): Diagnostic[] {
  if (document.languageId !== 'verilog') {
    return diagnostics;
  }
  const externalDiagnostics = state.verilogExternalDiagnostics.get(document.uri) ?? [];
  if (!externalDiagnostics.length) {
    return diagnostics;
  }
  const externalLines = new Set(externalDiagnostics.map((diagnostic) => diagnostic.range.start.line));
  const filtered = diagnostics.filter((diagnostic) => {
    const code = typeof diagnostic.code === 'string' ? diagnostic.code : '';
    return !(code.startsWith('syntax-') && externalLines.has(diagnostic.range.start.line));
  });
  return [...filtered, ...externalDiagnostics];
}

function scheduleExternalVerilogSyntaxCheck(document: TextDocument, settings: CoSettings): void {
  if (document.languageId !== 'verilog') {
    return;
  }
  const external = settings.verilog.syntax.external;
  if (external.mode !== 'onSave') {
    return;
  }
  const localDiagnostics = serviceForDocument(document)?.getDiagnostics?.(document, settings) ?? [];
  if (localDiagnostics.some((diagnostic) => diagnostic.severity === 1 && typeof diagnostic.code === 'string' && diagnostic.code.startsWith('syntax-'))) {
    clearExternalDiagnosticsForWorkspace(document.uri);
    void validateOpenVerilogDocuments();
    return;
  }
  const key = workspaceKeyForUri(document.uri);
  const existing = state.verilogExternalTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  state.verilogExternalTimers.set(key, setTimeout(() => {
    state.verilogExternalTimers.delete(key);
    void runExternalVerilogSyntaxCheck(document.uri, settings, false);
  }, 500));
}

async function runExternalVerilogSyntaxCheck(uri: string, settings: CoSettings, manual: boolean): Promise<void> {
  const external = settings.verilog.syntax.external;
  if (external.mode === 'off') {
    return;
  }
  if (!manual && external.mode !== 'onSave') {
    return;
  }
  const controllerKey = workspaceKeyForUri(uri);
  if (manual) {
    const scheduled = state.verilogExternalTimers.get(controllerKey);
    if (scheduled) {
      clearTimeout(scheduled);
      state.verilogExternalTimers.delete(controllerKey);
    }
  }
  const runId = (state.verilogExternalRunSequences.get(controllerKey) ?? 0) + 1;
  state.verilogExternalRunSequences.set(controllerKey, runId);
  state.verilogExternalControllers.get(controllerKey)?.abort();
  const controller = new AbortController();
  state.verilogExternalControllers.set(controllerKey, controller);
  const configuredTop = settings.project.topModule.trim();
  const fallbackTop = verilogIndex.indexedModules()[0]?.name;
  const topModule = configuredTop && verilogIndex.getModule(configuredTop)
    ? configuredTop
    : fallbackTop ?? configuredTop;
  let result: Awaited<ReturnType<typeof executeExternalVerilogSyntaxCheck>>;
  try {
    result = await executeExternalVerilogSyntaxCheck({
      workspaceFolders: state.workspaceFolders,
      triggerUri: uri,
      extensionRoot: state.extensionRoot,
      isePath: settings.toolchain.isePath,
      topModule,
      fallbackTopModule: fallbackTop,
      timeoutMs: external.timeoutMs > 0 ? external.timeoutMs : settings.run.timeoutMs,
      settings,
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted || runId !== state.verilogExternalRunSequences.get(controllerKey)) {
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const message = `外部 Verilog 语法检查失败：${detail}`;
    logExternalSyntaxFailure('iverilog', message);
    clearExternalDiagnosticsForWorkspace(uri);
    state.verilogExternalDiagnostics.set(uri, [{
      range: Range.create(0, 0, 0, 1),
      severity: 1,
      source: 'Icarus Verilog',
      code: 'iverilog-toolchain',
      message
    }]);
    if (state.notifiedExternalToolchainError !== message) {
      state.notifiedExternalToolchainError = message;
      void connection.window.showErrorMessage(message);
    }
    await validateOpenVerilogDocuments();
    return;
  } finally {
    if (state.verilogExternalControllers.get(controllerKey) === controller) {
      state.verilogExternalControllers.delete(controllerKey);
    }
  }
  if (runId !== state.verilogExternalRunSequences.get(controllerKey)) {
    return;
  }
  if (result.skipped) {
    clearExternalDiagnosticsForWorkspace(uri);
    await validateOpenVerilogDocuments();
    return;
  }
  if (result.toolchainError && state.notifiedExternalToolchainError !== result.toolchainError) {
    state.notifiedExternalToolchainError = result.toolchainError;
    void connection.window.showErrorMessage(result.toolchainError);
  } else if (!result.toolchainError) {
    state.notifiedExternalToolchainError = undefined;
  }
  if (!result.ok) {
    logExternalSyntaxFailure(result.backend, result.stderr || result.stdout);
  }
  clearExternalDiagnosticsForWorkspace(uri);
  for (const [diagnosticUri, diagnostics] of result.diagnosticsByUri) {
    state.verilogExternalDiagnostics.set(diagnosticUri, diagnostics);
  }
  await validateOpenVerilogDocuments();
}

async function validateOpenVerilogDocuments(): Promise<void> {
  await validateDocuments((document) => document.languageId === 'verilog');
}

function getCodeActions(
  document: TextDocument,
  range: Range,
  diagnostics: Diagnostic[],
  settings: CoSettings,
  service: CoLanguageService
): CodeAction[] {
  const languageActions = service.getCodeActions?.(document, range, diagnostics, settings) ?? [];
  return [
    ...languageActions,
    ...getDiagnosticSuppressActions(serviceKeyForDocument(document), diagnostics, settings, document.uri)
  ];
}

async function validateAllDocuments(): Promise<void> {
  await validateDocuments(() => true);
}

const validationBatchSize = 5;

async function validateDocuments(predicate: (document: TextDocument) => boolean): Promise<void> {
  const pendingDocuments = documents.all().filter(predicate);
  for (let i = 0; i < pendingDocuments.length; i += validationBatchSize) {
    const batch = pendingDocuments.slice(i, i + validationBatchSize);
    await Promise.all(batch.map((document) => validateDocument(document)));
  }
}

function scheduleVerilogIndexRebuild(delayMs = 0): void {
  if (verilogIndexRebuildTimer) {
    clearTimeout(verilogIndexRebuildTimer);
  }
  verilogIndexRebuildTimer = setTimeout(() => {
    verilogIndexRebuildTimer = undefined;
    void rebuildVerilogIndex();
  }, Math.max(0, delayMs));
}

async function rebuildVerilogIndex(): Promise<void> {
  const finishTrace = startupTraceEnabled()
    ? timeStartup('verilog workspace index rebuild')
    : undefined;
  try {
    const settings = await getDocumentSettings('');
    await verilogIndex.rebuild(state.workspaceFolders, settings);
    for (const document of documents.all()) {
      serviceForDocument(document)?.updateDocument?.(document, settings);
    }
    await validateOpenVerilogDocuments();
  } finally {
    finishTrace?.();
  }
}

function refreshSemanticTokens(): void {
  if (!state.hasSemanticTokensRefreshSupport) {
    return;
  }
  try {
    void Promise.resolve(connection.languages.semanticTokens.refresh()).catch((error) => {
      traceServerStartup(`semantic tokens refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    traceServerStartup(`semantic tokens refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function effectiveSettingsForDocument(document: TextDocument, settings: CoSettings): CoSettings {
  if (!needsProfileInference(settings)) {
    return settings;
  }
  return cachedEffectiveSettings(effectiveSettingsCacheKey(document.uri, document.version), () => {
    const snapshot = verilogProfileSnapshot();
    return applyResolvedProfile(settings, {
      activeLanguageId: serviceKeyForDocument(document),
      activeFilePath: fsPathFromUri(document.uri),
      files: profileFilesWithActive(snapshot.files, document.uri, serviceKeyForDocument(document)),
      modules: snapshot.modules,
      verilogDisplayFormats: verilogDisplayFormatsWithActive(snapshot, document)
    });
  });
}

function verilogProfileSnapshot(): VerilogProfileSnapshot {
  if (state.verilogProfileSnapshot?.indexVersion === verilogIndex.version) {
    return state.verilogProfileSnapshot;
  }
  const files = verilogIndex.indexedFiles()
    .map((file) => ({ path: fsPathFromUri(file.uri), languageId: 'verilog' }))
    .filter((file): file is { path: string; languageId: string } => Boolean(file.path));
  const snapshot: VerilogProfileSnapshot = {
    indexVersion: verilogIndex.version,
    files,
    modules: verilogIndex.allModules(),
    verilogDisplayFormatsByUri: new Map(verilogIndex.indexedFiles().map((file) => [file.uri, file.displayFormats]))
  };
  state.verilogProfileSnapshot = snapshot;
  return snapshot;
}

function verilogDisplayFormatsWithActive(snapshot: VerilogProfileSnapshot, document?: TextDocument): string[] {
  const formats: string[] = [];
  for (const [uri, fileFormats] of snapshot.verilogDisplayFormatsByUri) {
    if (document?.languageId === 'verilog' && uri === document.uri) {
      continue;
    }
    formats.push(...fileFormats);
  }
  if (document?.languageId === 'verilog') {
    formats.push(...extractVerilogDisplayFormats(document.getText()));
  }
  return formats;
}

function profileFilesWithActive(
  files: Array<{ path: string; languageId?: string }>,
  uri: string,
  languageId: string
): Array<{ path: string; languageId?: string }> {
  const activePath = fsPathFromUri(uri);
  if (!activePath || files.some((file) => samePath(file.path, activePath))) {
    return files;
  }
  return [...files, { path: activePath, languageId }];
}

function cachedEffectiveSettings(key: string, resolve: () => CoSettings): CoSettings {
  const cached = state.effectiveSettingsCache.get(key);
  if (cached) {
    state.effectiveSettingsCache.delete(key);
    state.effectiveSettingsCache.set(key, cached);
    return cached;
  }
  const resolved = resolve();
  state.effectiveSettingsCache.set(key, resolved);
  while (state.effectiveSettingsCache.size > maxEffectiveSettingsCacheEntries) {
    const oldest = state.effectiveSettingsCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    state.effectiveSettingsCache.delete(oldest);
  }
  return resolved;
}

function effectiveSettingsCacheKey(uri: string, documentVersion: number): string {
  return [
    uri,
    documentVersion,
    state.configurationVersion,
    verilogIndex.version
  ].join('\u0000');
}

function fsPathFromUri(uri: string): string | undefined {
  try {
    return URI.parse(uri).fsPath;
  } catch {
    // URI 格式异常时回退到 undefined，由调用方处理
    return undefined;
  }
}

function workspaceKeyForUri(uri: string): string {
  const file = fsPathFromUri(uri);
  const folder = state.workspaceFolders
    ?.map((candidate) => ({ uri: candidate.uri, path: fsPathFromUri(candidate.uri) }))
    .filter((candidate): candidate is { uri: string; path: string } => Boolean(candidate.path))
    .sort((left, right) => right.path.length - left.path.length)
    .find((candidate) => file ? isInsideDirectory(file, candidate.path) : false);
  return folder?.uri ?? uri;
}

function isWorkspaceVerilogUri(uri: string): boolean {
  if (!isVerilogUri(uri)) {
    return false;
  }
  const file = fsPathFromUri(uri);
  if (!file) {
    return false;
  }
  return Boolean(state.workspaceFolders
    ?.map((folder) => fsPathFromUri(folder.uri))
    .filter((folderPath): folderPath is string => Boolean(folderPath))
    .some((folderPath) => isInsideDirectory(file, folderPath)));
}

function isInsideDirectory(file: string, dir: string): boolean {
  const relative = pathRelative(dir, file);
  return relative === '' || (!relative.startsWith('..') && !/^[A-Za-z]:/.test(relative) && !relative.startsWith('/'));
}

function pathRelative(from: string, to: string): string {
  const normalizedFrom = from.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedTo = to.replace(/\\/g, '/');
  if (normalizedTo.toLowerCase().startsWith(`${normalizedFrom.toLowerCase()}/`) || normalizedTo.toLowerCase() === normalizedFrom.toLowerCase()) {
    return normalizedTo.slice(normalizedFrom.length).replace(/^\/+/, '');
  }
  return '..';
}

async function handleWatchedFilesChanged(changes: FileEvent[]): Promise<Set<string>> {
  const verilogChanges = changes.filter((change) => isVerilogUri(change.uri));
  const affectedLanguageIds = new Set<string>();
  if (!verilogChanges.length) {
    return affectedLanguageIds;
  }
  affectedLanguageIds.add('verilog');
  affectedLanguageIds.add('*');
  if (verilogChanges.length > 50) {
    await rebuildVerilogIndex();
    return affectedLanguageIds;
  }
  const settings = await getDocumentSettings('');
  for (const change of verilogChanges) {
    if (change.type === FileChangeType.Deleted) {
      verilogIndex.remove(change.uri);
      continue;
    }
    const openDocument = documents.get(change.uri);
    if (openDocument) {
      verilogIndex.updateDocument(openDocument, settings);
    } else {
      await verilogIndex.updateFileAsync(change.uri, settings);
    }
  }
  return affectedLanguageIds;
}

function isMipsDocument(document: TextDocument): boolean {
  return document.languageId === 'mipsasm';
}

function serviceForDocument(document: TextDocument): CoLanguageService | undefined {
  return languageServices.get(serviceKeyForDocument(document));
}

function serviceKeyForDocument(document: TextDocument): string {
  if (isLogisimCircuitUri(document.uri)) {
    return logisimLanguageId;
  }
  return document.languageId;
}

function isLogisimCircuitUri(uri: string): boolean {
  return uri.split(/[?#]/, 1)[0].toLowerCase().endsWith('.circ');
}

async function getDocumentSettings(resource: string): Promise<CoSettings> {
  if (!state.hasConfigurationCapability) {
    return state.globalSettings;
  }
  let result = state.documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource || undefined,
      section: 'co'
    }).then(mergeCoSettings);
    state.documentSettings.set(resource, result);
  }
  return result;
}

async function settingsForUri(uri: string): Promise<CoSettings> {
  const settings = await getDocumentSettings(uri);
  const document = documents.get(uri);
  if (document) {
    return effectiveSettingsForDocument(document, settings);
  }
  if (!needsProfileInference(settings)) {
    return settings;
  }
  return cachedEffectiveSettings(effectiveSettingsCacheKey(uri, 0), () => {
    const languageId = isVerilogUri(uri) ? 'verilog' : '';
    const snapshot = verilogProfileSnapshot();
    return applyResolvedProfile(settings, {
      activeLanguageId: languageId,
      activeFilePath: fsPathFromUri(uri),
      files: profileFilesWithActive(snapshot.files, uri, languageId),
      modules: snapshot.modules,
      verilogDisplayFormats: verilogDisplayFormatsWithActive(snapshot)
    });
  });
}

function needsProfileInference(settings: CoSettings): boolean {
  return settings.project.profile === 'auto';
}

documents.listen(connection);
connection.listen();
