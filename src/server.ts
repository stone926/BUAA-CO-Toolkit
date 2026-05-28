import {
  CodeActionKind,
  createConnection,
  DidChangeConfigurationNotification,
  InitializeParams,
  InitializeResult,
  ProposedFeatures,
  SemanticTokens,
  TextDocumentSyncKind,
  TextDocuments,
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
  getMipsFormattingEdits,
  getMipsHover,
  getMipsReferences,
  getMipsSemanticTokens,
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
  getVerilogHover
} from './language/verilog/service';
import { VerilogWorkspaceIndex } from './language/verilog/workspaceIndex';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const verilogIndex = new VerilogWorkspaceIndex();
const mipsState: MipsServerState = {
  ignoredPseudoInstructionFiles: new Set(),
  ignoredPseudoInstructionMnemonics: new Set()
};

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
        codeActionKinds: [CodeActionKind.QuickFix]
      },
      documentFormattingProvider: true,
      executeCommandProvider: {
        commands: [mipsIgnorePseudoFileCommand, mipsIgnorePseudoMnemonicCommand]
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...mipsSemanticTokenTypes],
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

connection.onDidChangeWatchedFiles(() => {
  void rebuildVerilogIndex().then(validateAllDocuments);
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
  verilogIndex.remove(event.document.uri);
  connection.sendDiagnostics({
    uri: event.document.uri,
    diagnostics: []
  });
});

connection.onCompletion(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const settings = await getDocumentSettings(document.uri);
  if (document.languageId === 'mipsasm') {
    return getMipsCompletions(document, params.position, settings, mipsState);
  }
  if (document.languageId === 'verilog') {
    return getVerilogCompletions(document, params.position, settings, verilogIndex);
  }
  return [];
});

connection.onHover(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return undefined;
  }
  const settings = await getDocumentSettings(document.uri);
  if (document.languageId === 'mipsasm') {
    return getMipsHover(document, params.position, settings, mipsState);
  }
  if (document.languageId === 'verilog') {
    return getVerilogHover(document, params.position, settings, verilogIndex);
  }
  if (document.languageId === 'logisim-circ') {
    return getLogisimHover(document, params.position);
  }
  return undefined;
});

connection.onDefinition(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return undefined;
  }
  const settings = await getDocumentSettings(document.uri);
  if (document.languageId === 'mipsasm') {
    return getMipsDefinition(document, params.position, settings, mipsState);
  }
  if (document.languageId === 'verilog') {
    return getVerilogDefinition(document, params.position, settings, verilogIndex);
  }
  return undefined;
});

connection.onReferences(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const settings = await getDocumentSettings(document.uri);
  if (document.languageId === 'mipsasm') {
    return getMipsReferences(document, params, settings, mipsState);
  }
  return [];
});

connection.onDocumentSymbol(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const settings = await getDocumentSettings(document.uri);
  if (document.languageId === 'mipsasm') {
    return getMipsDocumentSymbols(document, settings, mipsState);
  }
  if (document.languageId === 'verilog') {
    return getVerilogDocumentSymbols(document, settings);
  }
  if (document.languageId === 'logisim-circ') {
    return getLogisimDocumentSymbols(document);
  }
  return [];
});

connection.onCodeAction(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const settings = await getDocumentSettings(document.uri);
  if (document.languageId === 'mipsasm') {
    return getMipsCodeActions(document, params.context.diagnostics);
  }
  if (document.languageId === 'verilog') {
    return getVerilogCodeActions(document, params.range, params.context.diagnostics, settings);
  }
  return [];
});

connection.onDocumentFormatting((params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document || document.languageId !== 'mipsasm') {
    return [];
  }
  return getMipsFormattingEdits(document);
});

connection.languages.semanticTokens.on(async (params): Promise<SemanticTokens> => {
  const document = documents.get(params.textDocument.uri);
  if (!document || document.languageId !== 'mipsasm') {
    return { data: [] };
  }
  const settings = await getDocumentSettings(document.uri);
  return getMipsSemanticTokens(document, settings, mipsState);
});

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
  if (document.languageId === 'verilog') {
    verilogIndex.updateDocument(document, settings);
  }
  await validateDocument(document, settings);
}

async function validateDocument(document: TextDocument, settings?: CoSettings): Promise<void> {
  const resolvedSettings = settings ?? await getDocumentSettings(document.uri);
  if (document.languageId === 'mipsasm') {
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: getMipsDiagnostics(document, resolvedSettings, mipsState)
    });
  } else if (document.languageId === 'verilog') {
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: getVerilogDiagnostics(document, resolvedSettings)
    });
  } else if (document.languageId === 'logisim-circ') {
    connection.sendDiagnostics({
      uri: document.uri,
      diagnostics: getLogisimDiagnostics(document)
    });
  }
}

async function validateAllDocuments(): Promise<void> {
  for (const document of documents.all()) {
    await validateDocument(document);
  }
}

async function rebuildVerilogIndex(): Promise<void> {
  const settings = await getDocumentSettings('');
  await verilogIndex.rebuild(workspaceFolders, settings);
  for (const document of documents.all()) {
    if (document.languageId === 'verilog') {
      verilogIndex.updateDocument(document, settings);
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
