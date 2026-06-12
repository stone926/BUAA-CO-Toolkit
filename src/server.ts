import {
  CodeAction,
  CodeActionKind,
  CompletionItem,
  createConnection,
  DidChangeConfigurationNotification,
  Diagnostic,
  DocumentFormattingRequest,
  DocumentSymbol,
  FileChangeType,
  FileEvent,
  FoldingRange,
  FormattingOptions,
  Hover,
  InlayHint,
  InitializeParams,
  InitializeResult,
  Location,
  Position,
  ProposedFeatures,
  Range,
  ReferenceParams,
  SemanticTokens,
  SignatureHelp,
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

let hasConfigurationCapability = false;
let hasFormattingDynamicRegistration = false;
let workspaceFolders: WorkspaceFolder[] | null | undefined;
let globalSettings: CoSettings = defaultCoSettings;
const documentSettings = new Map<string, Thenable<CoSettings>>();
const updatedDocumentVersions = new Map<string, number>();
const contentChangeTimers = new Map<string, ReturnType<typeof setTimeout>>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
  hasFormattingDynamicRegistration = Boolean(params.capabilities.textDocument?.formatting?.dynamicRegistration);
  workspaceFolders = params.workspaceFolders;

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
        commands: [mipsIgnorePseudoFileCommand, mipsIgnorePseudoMnemonicCommand]
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
  if (hasConfigurationCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
  }
  if (hasFormattingDynamicRegistration) {
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
  if (hasConfigurationCapability) {
    documentSettings.clear();
  } else {
    globalSettings = mergeCoSettings(change.settings?.co);
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
  const existing = contentChangeTimers.get(event.document.uri);
  if (existing) {
    clearTimeout(existing);
  }
  contentChangeTimers.set(event.document.uri, setTimeout(() => {
    contentChangeTimers.delete(event.document.uri);
    void updateIndexAndValidate(event.document);
  }, 250));
});

documents.onDidSave((event) => {
  if (updatedDocumentVersions.get(event.document.uri) === event.document.version) {
    return;
  }
  void updateIndexAndValidate(event.document);
});

documents.onDidClose((event) => {
  const timer = contentChangeTimers.get(event.document.uri);
  if (timer) {
    clearTimeout(timer);
    contentChangeTimers.delete(event.document.uri);
  }
  documentSettings.delete(event.document.uri);
  updatedDocumentVersions.delete(event.document.uri);
  serviceForDocument(event.document)?.removeDocument?.(event.document.uri);
  connection.sendDiagnostics({
    uri: event.document.uri,
    diagnostics: []
  });
});

function withDocument<R>(
  handler: (doc: TextDocument, params: any, settings: CoSettings, svc: CoLanguageService) => R | undefined,
  fallback: R
): (params: any) => Promise<R> {
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
  (doc, params, _settings, svc) => svc.getCompletions?.(doc, params.position, _settings), []
));

connection.onHover(withDocument(
  (doc, params, settings, svc) => svc.getHover?.(doc, params.position, settings), undefined
));

connection.onDefinition(withDocument(
  (doc, params, settings, svc) => svc.getDefinition?.(doc, params.position, settings), undefined
));

connection.onReferences(withDocument(
  (doc, params, settings, svc) => svc.getReferences?.(doc, params, settings), []
));

connection.onDocumentSymbol(withDocument(
  (doc, _params, settings, svc) => svc.getDocumentSymbols?.(doc, settings), []
));

connection.onCodeAction(withDocument(
  (doc, params, settings, svc) => getCodeActions(doc, params.range, params.context.diagnostics, settings, svc), []
));

connection.onDocumentFormatting(withDocument(
  (doc, params, settings, svc) => svc.getFormattingEdits?.(doc, settings, params.options), []
));

connection.languages.inlayHint.on(withDocument(
  (doc, params, settings, svc) => svc.getInlayHints?.(doc, params.range, settings), [] as InlayHint[]
));

connection.languages.semanticTokens.on(withDocument(
  (doc, _params, settings, svc) => svc.getSemanticTokens?.(doc, settings), { data: [] } as SemanticTokens
));

connection.onFoldingRanges(withDocument(
  (doc, _params, settings, svc) => svc.getFoldingRanges?.(doc, settings), [] as FoldingRange[]
));

connection.onSignatureHelp(withDocument(
  (doc, params, settings, svc) => svc.getSignatureHelp?.(doc, params.position, settings), undefined
));

connection.onRenameRequest(withDocument(
  (doc, params, settings, svc) => svc.getRenameEdits?.(doc, params.position, params.newName, settings), undefined
));

connection.onPrepareRename(withDocument(
  (doc, params, settings, svc) => svc.getRenamePrepare?.(doc, params.position, settings), undefined
));

connection.onExecuteCommand(async (params) => {
  if (params.command === mipsIgnorePseudoFileCommand && typeof params.arguments?.[0] === 'string') {
    mipsState.ignoredPseudoInstructionFiles.add(params.arguments[0]);
    await validateDocuments(isMipsDocument);
  } else if (params.command === mipsIgnorePseudoMnemonicCommand && typeof params.arguments?.[0] === 'string') {
    mipsState.ignoredPseudoInstructionMnemonics.add(params.arguments[0].toLowerCase());
    await validateDocuments(isMipsDocument);
  }
});

async function updateIndexAndValidate(document: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(document.uri);
  serviceForDocument(document)?.updateDocument?.(document, settings);
  await validateDocument(document, settings);
  updatedDocumentVersions.set(document.uri, document.version);
}

async function validateDocument(document: TextDocument, settings?: CoSettings): Promise<void> {
  const resolvedSettings = effectiveSettingsForDocument(document, settings ?? await getDocumentSettings(document.uri));
  const diagnosticLanguageId = serviceKeyForDocument(document);
  const diagnostics = filterDisabledDiagnostics(
    diagnosticLanguageId,
    serviceForDocument(document)?.getDiagnostics?.(document, resolvedSettings) ?? [],
    resolvedSettings,
    document.uri
  );
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics
  });
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

async function validateDocuments(predicate: (document: TextDocument) => boolean): Promise<void> {
  await Promise.all(documents.all().filter(predicate).map((document) => validateDocument(document)));
}

async function rebuildVerilogIndex(): Promise<void> {
  const settings = await getDocumentSettings('');
  await verilogIndex.rebuild(workspaceFolders, settings);
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
    return undefined;
  }
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
      verilogIndex.updateFile(change.uri, settings);
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
  if (!hasConfigurationCapability) {
    return globalSettings;
  }
  let result = documentSettings.get(resource);
  if (!result) {
    result = connection.workspace.getConfiguration({
      scopeUri: resource || undefined,
      section: 'co'
    }).then(mergeCoSettings);
    documentSettings.set(resource, result);
  }
  return result;
}

documents.listen(connection);
connection.listen();
