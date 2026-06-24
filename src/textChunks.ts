export class TextChunkAccumulator {
  private readonly chunks: string[] = [];

  append(text: string): void {
    if (text.length) {
      this.chunks.push(text);
    }
  }

  toString(): string {
    if (this.chunks.length === 0) {
      return '';
    }
    if (this.chunks.length === 1) {
      return this.chunks[0];
    }
    return this.chunks.join('');
  }
}

export class LineChunkScanner {
  private pending = '';

  constructor(private readonly onLine: (line: string) => void) {}

  append(text: string): void {
    if (!text.length) {
      return;
    }
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) !== 10) {
        continue;
      }
      let end = i;
      if (end > start && text.charCodeAt(end - 1) === 13) {
        end--;
      } else if (end === start && this.pending.endsWith('\r')) {
        this.pending = this.pending.slice(0, -1);
      }
      this.onLine(this.pending + text.slice(start, end));
      this.pending = '';
      start = i + 1;
    }
    if (start < text.length) {
      this.pending += text.slice(start);
    }
  }

  flush(): void {
    if (!this.pending.length) {
      return;
    }
    this.onLine(this.pending);
    this.pending = '';
  }
}
