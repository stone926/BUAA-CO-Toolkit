export class ProgramWriter {
  private readonly lines: string[] = [];
  private instructionCount = 0;

  constructor(private readonly textBase: number) {}

  label(name: string): void {
    this.lines.push(`${name}:`);
  }

  emit(text: string): void {
    this.lines.push(`    ${text}`);
    this.instructionCount++;
  }

  raw(text: string): void {
    this.lines.push(text);
  }

  pc(): number {
    return this.textBase + this.instructionCount * 4;
  }

  count(): number {
    return this.instructionCount;
  }

  render(): string[] {
    return [...this.lines];
  }
}

