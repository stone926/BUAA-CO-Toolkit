// @index formatting-request — 格式化请求的配置等待、取消与文档版本保护
import type { CancellationToken, TextEdit } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

interface FormattingRequestParams {
  textDocument: { uri: string };
}

export function createFormattingRequestHandler<P extends FormattingRequestParams, S>(dependencies: {
  getDocument(uri: string): TextDocument | undefined;
  getSettings(uri: string): PromiseLike<S>;
  format(document: TextDocument, params: P, settings: S): TextEdit[];
  onError(error: unknown): void;
}): (params: P, token: CancellationToken) => Promise<TextEdit[]> {
  return async (params, token) => {
    try {
      if (token.isCancellationRequested) return [];
      const uri = params.textDocument.uri;
      const document = dependencies.getDocument(uri);
      if (!document) return [];
      // TextDocuments 会原地更新对象，必须在 await 前保存版本值。
      const version = document.version;
      const settings = await dependencies.getSettings(uri);
      const current = dependencies.getDocument(uri);
      if (token.isCancellationRequested || current !== document || current.version !== version) return [];
      // 核心是同步计算；这里仅在异步配置边界检查取消，不承诺中途抢占。
      return dependencies.format(current, params, settings);
    } catch (error) {
      dependencies.onError(error);
      return [];
    }
  };
}
