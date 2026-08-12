// @index document-result-cache — 每文档/判别器仅保留最新结果的 LRU 缓存
import { TextDocument } from 'vscode-languageserver-textdocument';

interface CacheEntry<T> {
  uri: string;
  discriminator: string;
  version: number;
  text: string;
  value: T;
}

/**
 * Keeps one current generation for each URI/discriminator pair.
 *
 * LSP document versions grow on every edit, so version must not be part of the
 * map key: retaining every version keeps several complete ASTs for a large file.
 * Exact text equality also permits safe reuse when a client recreates a document
 * with a different version; unlike a short hash it cannot return a false hit.
 */
export class DocumentResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 16) {}

  getOrCreate(document: TextDocument, discriminator: string, create: () => T): T {
    const key = documentCacheKey(document.uri, discriminator);
    const cached = this.entries.get(key);
    const text = document.getText();
    if (cached && cached.text === text) {
      cached.version = document.version;
      this.touch(key, cached);
      return cached.value;
    }

    const value = create();
    this.store(key, {
      uri: document.uri,
      discriminator,
      version: document.version,
      text,
      value
    });
    return value;
  }

  clear(uri?: string): void {
    if (!uri) {
      this.entries.clear();
      return;
    }
    for (const [key, cached] of this.entries) {
      if (cached.uri === uri) {
        this.entries.delete(key);
      }
    }
  }

  private store(key: string, value: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
  }

  private touch(key: string, value: CacheEntry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, value);
  }
}

function documentCacheKey(uri: string, discriminator: string): string {
  return `${uri}\u0000${discriminator}`;
}
