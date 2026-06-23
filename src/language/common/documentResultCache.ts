import { TextDocument } from 'vscode-languageserver-textdocument';

interface CacheEntry<T> {
  uri: string;
  version: number;
  discriminator: string;
  text: string;
  textKey: string;
  value: T;
}

export class DocumentResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 16) {}

  getOrCreate(document: TextDocument, discriminator: string, create: () => T): T {
    const text = document.getText();
    const key = documentCacheKey(document.uri, document.version, discriminator);
    const cached = this.entries.get(key);
    let currentTextKey: string | undefined;
    if (cached) {
      if (cached.text === text) {
        this.touch(key, cached);
        return cached.value;
      }
      if (cached.text.length === text.length) {
        currentTextKey = textKey(text);
        if (cached.textKey === currentTextKey) {
          this.touch(key, cached);
          return cached.value;
        }
      }
    }

    const value = create();
    this.store(key, {
      uri: document.uri,
      version: document.version,
      discriminator,
      text,
      textKey: currentTextKey ?? textKey(text),
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
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
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

function documentCacheKey(uri: string, version: number, discriminator: string): string {
  return `${uri}\u0000${version}\u0000${discriminator}`;
}

function textKey(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}
