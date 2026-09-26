// @index language-registry — Shared manifest language identities, LSP selectors and routing.
import { languageCatalog, languageServiceIds, LanguageServiceId } from './generated/languages';
export { languageIds, languageServiceIds, LanguageServiceId } from './generated/languages';

interface LanguageRegistration {
  readonly id: string;
  readonly extensions: readonly string[];
  readonly lsp?: {
    readonly selector: 'language' | 'extension';
    readonly formatting: boolean;
  };
}

const registrations: readonly LanguageRegistration[] = languageCatalog;
const services = new Set<string>(languageServiceIds);
const extensionsById = new Map(registrations.map(({ id, extensions }) => [id, extensions]));

export function isLanguageFileName(fileName: string, languageId: string): boolean {
  const lower = fileName.toLowerCase();
  return extensionsById.get(languageId)?.some((extension) => lower.endsWith(extension)) ?? false;
}

export function languageDocumentSelector(formattingOnly = false): Array<{ scheme: string; language?: string; pattern?: string }> {
  return registrations.filter(({ lsp }) => lsp && (!formattingOnly || lsp.formatting)).flatMap<{ scheme: string; language?: string; pattern?: string }>(({ id, extensions, lsp }) =>
    lsp!.selector === 'language'
      ? [{ scheme: 'file', language: id }]
      : extensions.map((extension) => ({ scheme: 'file', pattern: `**/*${extension}` }))
  );
}

export function languageFileGlob(ids: readonly string[] = languageServiceIds): string {
  const extensions = registrations.filter(({ id }) => ids.includes(id)).flatMap(({ extensions }) => extensions.map((extension) => extension.slice(1)));
  if (!extensions.length) throw new Error('A language file glob requires a registered language.');
  return extensions.length === 1 ? `**/*.${extensions[0]}` : `**/*.{${extensions.join(',')}}`;
}

/** Extension-selected services (Logisim XML) take priority; syntax-only languages have no service. */
export function languageServiceForDocument(document: { languageId: string; uri: string }): LanguageServiceId | undefined {
  const pathname = document.uri.split(/[?#]/, 1)[0].toLowerCase();
  const extensionService = registrations.find(({ extensions, lsp }) =>
    lsp?.selector === 'extension' && extensions.some((extension) => pathname.endsWith(extension)));
  const id = extensionService?.id ?? document.languageId;
  return services.has(id) ? id as LanguageServiceId : undefined;
}
