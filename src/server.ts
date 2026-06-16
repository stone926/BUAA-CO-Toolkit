import {
  CodeAction,
  CodeActionKind,
  CodeActionParams,
  CompletionItem,
  CompletionParams,
  createConnection,
  DefinitionParams,
  DidChangeConfigurationNotification,
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
import { applyResolvedProfile } from './profileResolver';
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
import { runIseSyntaxCheck } from './language/verilog/iseSyntaxCheck';
import { verilogSemanticTokenTypes } from './language/verilog/model';
import { isVerilogUri, VerilogWorkspaceIndex } from './language/verilog/workspaceIndex';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const verilogIndex = new VerilogWorkspaceIndex();
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
  removeDocument?: (uri: string) => void;
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
    getSemanticTokens: (document, settings) => getVerilogSemanticTokens(document, settings, verilogIndex),
    getFoldingRanges: getVerilogFoldingRanges,
    getSignatureHelp: (document, position, settings) => getVerilogSignatureHelp(document, position, settings, verilogIndex),
    getRenameEdits: (document, position, newName, settings) => getVerilogRenameEdits(document, position, newName, settings, verilogIndex),
    getRenamePrepare: (document, position, settings) => getVerilogRenamePrepare(document, position, settings, verilogIndex),
    updateDocument: (document, settings) => verilogIndex.updateDocument(document, settings),
    removeDocument: (uri) => verilogIndex.remove(uri)
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
  workspaceFolders: WorkspaceFolder[] | null | undefined;
  globalSettings: CoSettings;
  documentSettings: Map<string, Thenable<CoSettings>>;
  updatedDocumentVersions: Map<string, number>;
  contentChangeTimers: Map<string, ReturnType<typeof setTimeout>>;
  verilogIseDiagnostics: Map<string, Diagnostic[]>;
  verilogIseTimers: Map<string, ReturnType<typeof setTimeout>>;
  verilogIseRunSequence: number;
  notifiedMissingIseToolchain: boolean;
}

const state: ServerState = {
  hasConfigurationCapability: false,
  hasFormattingDynamicRegistration: false,
  workspaceFolders: undefined,
  globalSettings: defaultCoSettings,
  documentSettings: new Map(),
  updatedDocumentVersions: new Map(),
  contentChangeTimers: new Map(),
  verilogIseDiagnostics: new Map(),
  verilogIseTimers: new Map(),
  verilogIseRunSequence: 0,
  notifiedMissingIseToolchain: false
};
const verilogIseCommand = 'co.internal.verilog.checkSyntaxWithIse';

connection.onInitialize((params: InitializeParams): InitializeResult => {
  state.hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
  state.hasFormattingDynamicRegistration = Boolean(params.capabilities.textDocument?.formatting?.dynamicRegistration);
  state.workspaceFolders = params.workspaceFolders;

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
        commands: [mipsIgnorePseudoFileCommand, mipsIgnorePseudoMnemonicCommand, verilogIseCommand]
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
  if (state.hasConfigurationCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (state.hasFormattingDynamicRegistration) {
    void connection.client.register(DocumentFormattingRequest.type, {
      documentSelector: [
        { scheme: 'file', language: 'mipsasm' },
        { scheme: 'file', language: 'verilog' }
      ]
    });
  }
  void rebuildVerilogIndex();
});

connection.onDidChangeConfiguration((change) => {
  if (state.hasConfigurationCapability) {
    state.documentSettings.clear();
  } else {
    state.globalSettings = mergeCoSettings(change.settings?.co);
  }
  void rebuildVerilogIndex();
  void validateAllDocuments();
});

connection.onDidChangeWatchedFiles((params) => {
  void handleWatchedFilesChanged(params.changes).then((languageIds) =>
    languageIds.has('*') ? validateAllDocuments() : validateDocuments((document) => languageIds.has(document.languageId))
  );
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
  const timer = state.contentChangeTimers.get(event.document.uri);
  if (timer) {
    clearTimeout(timer);
    state.contentChangeTimers.delete(event.document.uri);
  }
  state.documentSettings.delete(event.document.uri);
  state.updatedDocumentVersions.delete(event.document.uri);
  state.verilogIseDiagnostics.delete(event.document.uri);
  serviceForDocument(event.document)?.removeDocument?.(event.document.uri);
  connection.sendDiagnostics({
    uri: event.document.uri,
    diagnostics: []
  });
});

interface DocumentRequestParams {
  textDocument: {
    uri: string;
  };
}

function withDocument<P extends DocumentRequestParams, R>(
  handler: (doc: TextDocument, params: P, settings: CoSettings, svc: CoLanguageService) => R | undefined,
  fallback: R
): (params: P) => Promise<R> {
  return async (params) => {
    try {
      const document = documents.get(params.textDocument.uri);
      if (!document) return fallback;
      const settings = effectiveSettingsForDocument(document, await getDocumentSettings(document.uri));
      const svc = serviceForDocument(document);
      return svc ? (handler(document, params, settings, svc) ?? fallback) : fallback;
    } catch (e) {
      connection.console.error(`[BUAA CO Toolkit] 处理程序错误: ${e}`);
      return fallback;
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
  (doc, _params: SemanticTokensParams, settings, svc) => svc.getSemanticTokens?.(doc, settings), { data: [] } as SemanticTokens
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
  } else if (params.command === verilogIseCommand) {
    const uri = typeof params.arguments?.[0] === 'string'
      ? params.arguments[0]
      : documents.all().find((document) => document.languageId === 'verilog')?.uri;
    if (uri) {
      await runVerilogIseSyntaxCheck(uri, await settingsForUri(uri), true);
    }
  }
});

async function handleDocumentSaved(document: TextDocument): Promise<void> {
  if (state.updatedDocumentVersions.get(document.uri) !== document.version) {
    await updateIndexAndValidate(document);
  }
  const settings = effectiveSettingsForDocument(document, await getDocumentSettings(document.uri));
  scheduleVerilogIseSyntaxCheck(document, settings);
}

async function updateIndexAndValidate(document: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(document.uri);
  serviceForDocument(document)?.updateDocument?.(document, settings);
  await validateDocument(document, settings);
  state.updatedDocumentVersions.set(document.uri, document.version);
}

async function validateDocument(document: TextDocument, settings?: CoSettings): Promise<void> {
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
}

function mergeExternalDiagnostics(document: TextDocument, diagnostics: Diagnostic[]): Diagnostic[] {
  if (document.languageId !== 'verilog') {
    return diagnostics;
  }
  const iseDiagnostics = state.verilogIseDiagnostics.get(document.uri) ?? [];
  if (!iseDiagnostics.length) {
    return diagnostics;
  }
  const iseLines = new Set(iseDiagnostics.map((diagnostic) => diagnostic.range.start.line));
  const filtered = diagnostics.filter((diagnostic) => {
    const code = typeof diagnostic.code === 'string' ? diagnostic.code : '';
    return !(code.startsWith('syntax-') && iseLines.has(diagnostic.range.start.line));
  });
  return [...filtered, ...iseDiagnostics];
}

function scheduleVerilogIseSyntaxCheck(document: TextDocument, settings: CoSettings): void {
  if (document.languageId !== 'verilog') {
    return;
  }
  const ise = settings.verilog.syntax.ise;
  if (!ise.enabled || ise.mode !== 'onSave') {
    return;
  }
  const localDiagnostics = serviceForDocument(document)?.getDiagnostics?.(document, settings) ?? [];
  if (localDiagnostics.some((diagnostic) => diagnostic.severity === 1 && typeof diagnostic.code === 'string' && diagnostic.code.startsWith('syntax-'))) {
    state.verilogIseDiagnostics.delete(document.uri);
    void validateDocument(document, settings);
    return;
  }
  const key = workspaceKeyForUri(document.uri);
  const existing = state.verilogIseTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  state.verilogIseTimers.set(key, setTimeout(() => {
    state.verilogIseTimers.delete(key);
    void runVerilogIseSyntaxCheck(document.uri, settings, false);
  }, 500));
}

async function runVerilogIseSyntaxCheck(uri: string, settings: CoSettings, manual: boolean): Promise<void> {
  const ise = settings.verilog.syntax.ise;
  if (!ise.enabled || ise.mode === 'off') {
    return;
  }
  if (!manual && ise.mode !== 'onSave') {
    return;
  }
  const runId = ++state.verilogIseRunSequence;
  const configuredTop = settings.project.topModule.trim();
  const fallbackTop = verilogIndex.indexedModules()[0]?.name;
  const topModule = configuredTop && verilogIndex.getModule(configuredTop)
    ? configuredTop
    : fallbackTop ?? configuredTop;
  const result = await runIseSyntaxCheck({
    workspaceFolders: state.workspaceFolders,
    triggerUri: uri,
    isePath: settings.toolchain.isePath,
    topModule,
    fallbackTopModule: fallbackTop,
    timeoutMs: ise.timeoutMs > 0 ? ise.timeoutMs : settings.run.timeoutMs
  });
  if (runId !== state.verilogIseRunSequence) {
    return;
  }
  if (result.skipped === 'missing-toolchain') {
    state.verilogIseDiagnostics.clear();
    if (!state.notifiedMissingIseToolchain) {
      state.notifiedMissingIseToolchain = true;
      void connection.window.showInformationMessage('ISE fuse 未配置或不可用，Verilog 语法检查已回退到内置检查。');
    }
    await validateOpenVerilogDocuments();
    return;
  }
  if (result.skipped) {
    state.verilogIseDiagnostics.clear();
    await validateOpenVerilogDocuments();
    return;
  }
  state.notifiedMissingIseToolchain = false;
  state.verilogIseDiagnostics.clear();
  for (const [diagnosticUri, diagnostics] of result.diagnosticsByUri) {
    state.verilogIseDiagnostics.set(diagnosticUri, diagnostics);
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

async function rebuildVerilogIndex(): Promise<void> {
  const settings = await getDocumentSettings('');
  await verilogIndex.rebuild(state.workspaceFolders, settings);
  for (const document of documents.all()) {
    serviceForDocument(document)?.updateDocument?.(document, settings);
  }
}

function effectiveSettingsForDocument(document: TextDocument, settings: CoSettings): CoSettings {
  return applyResolvedProfile(settings, {
    activeLanguageId: serviceKeyForDocument(document),
    activeFilePath: fsPathFromUri(document.uri),
    files: indexedProfileFiles(document),
    modules: verilogIndex.allModules(),
    verilogTexts: verilogIndex.allFiles().map((file) => file.text)
  });
}

function indexedProfileFiles(document: TextDocument): Array<{ path: string; languageId?: string }> {
  const files = verilogIndex.allFiles()
    .map((file) => ({ path: fsPathFromUri(file.uri), languageId: 'verilog' }))
    .filter((file): file is { path: string; languageId: string } => Boolean(file.path));
  const activePath = fsPathFromUri(document.uri);
  if (activePath) {
    files.push({ path: activePath, languageId: serviceKeyForDocument(document) });
  }
  return files;
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
  const document = documents.get(uri);
  if (document) {
    return effectiveSettingsForDocument(document, await getDocumentSettings(uri));
  }
  return applyResolvedProfile(await getDocumentSettings(uri), {
    activeLanguageId: uri.toLowerCase().endsWith('.v') ? 'verilog' : '',
    activeFilePath: fsPathFromUri(uri),
    files: indexedProfileFiles(TextDocument.create(uri, uri.toLowerCase().endsWith('.v') ? 'verilog' : '', 0, '')),
    modules: verilogIndex.allModules(),
    verilogTexts: verilogIndex.allFiles().map((file) => file.text)
  });
}

documents.listen(connection);
connection.listen();
