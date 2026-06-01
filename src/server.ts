import {
  CodeAction,
  CodeActionKind,
  CompletionItem,
  createConnection,
  DidChangeConfigurationNotification,
  Diagnostic,
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
import { defaultCoSettings, mergeCoSettings, CoSettings } from './language/common/settings';
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
  ['logisim-circ', {
    getDiagnostics: (document) => getLogisimDiagnostics(document),
    getHover: (document, position) => getLogisimHover(document, position),
    getDocumentSymbols: (document) => getLogisimDocumentSymbols(document)
  }]
]);

let hasConfigurationCapability = false;
let workspaceFolders: WorkspaceFolder[] | null | undefined;
let globalSettings: CoSettings = defaultCoSettings;
const documentSettings = new Map<string, Thenable<CoSettings>>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  hasConfigurationCapability = Boolean(params.capabilities.workspace?.configuration);
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
      documentFormattingProvider: true,
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
      name: 'BUAA CO Language Server'
    }
  };
});

connection.onInitialized(() => {
  if (hasConfigurationCapability) {
    void connection.client.register(DidChangeConfigurationNotification.type, undefined);
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
  void handleWatchedFilesChanged(params.changes).then(validateAllDocuments);
});

documents.onDidOpen((event) => {
  void updateIndexAndValidate(event.document);
});

documents.onDidChangeContent((event) => {
  void updateIndexAndValidate(event.document);
});

documents.onDidSave((event) => {
  void updateIndexAndValidate(event.document);
});

documents.onDidClose((event) => {
  documentSettings.delete(event.document.uri);
  languageServices.get(event.document.languageId)?.removeDocument?.(event.document.uri);
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
      const settings = await getDocumentSettings(document.uri);
      const svc = languageServices.get(document.languageId);
      return svc ? (handler(document, params, settings, svc) ?? fallback) : fallback;
    } catch (e) {
      connection.console.error(`[BUAA CO] Handler error: ${e}`);
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
  (doc, params, settings, svc) => svc.getCodeActions?.(doc, params.range, params.context.diagnostics, settings), []
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
    await validateAllDocuments();
  } else if (params.command === mipsIgnorePseudoMnemonicCommand && typeof params.arguments?.[0] === 'string') {
    mipsState.ignoredPseudoInstructionMnemonics.add(params.arguments[0].toLowerCase());
    await validateAllDocuments();
  }
});

async function updateIndexAndValidate(document: TextDocument): Promise<void> {
  const settings = await getDocumentSettings(document.uri);
  languageServices.get(document.languageId)?.updateDocument?.(document, settings);
  await validateDocument(document, settings);
}

async function validateDocument(document: TextDocument, settings?: CoSettings): Promise<void> {
  const resolvedSettings = settings ?? await getDocumentSettings(document.uri);
  const diagnostics = languageServices.get(document.languageId)?.getDiagnostics?.(document, resolvedSettings) ?? [];
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics
  });
}

async function validateAllDocuments(): Promise<void> {
  await Promise.all(documents.all().map((document) => validateDocument(document)));
}

async function rebuildVerilogIndex(): Promise<void> {
  const settings = await getDocumentSettings('');
  await verilogIndex.rebuild(workspaceFolders, settings);
  for (const document of documents.all()) {
    languageServices.get(document.languageId)?.updateDocument?.(document, settings);
  }
}

async function handleWatchedFilesChanged(changes: FileEvent[]): Promise<void> {
  const verilogChanges = changes.filter((change) => isVerilogUri(change.uri));
  if (!verilogChanges.length) {
    return;
  }
  if (verilogChanges.length > 50) {
    await rebuildVerilogIndex();
    return;
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
