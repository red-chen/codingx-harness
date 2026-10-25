/** Tracks files read by tools during one agent session (read-before-write rule). */
export class ReadFileTracker {
  private readonly files = new Set<string>();

  markRead(absolutePath: string): void {
    this.files.add(absolutePath);
  }

  hasRead(absolutePath: string): boolean {
    return this.files.has(absolutePath);
  }

  clear(): void {
    this.files.clear();
  }

  get size(): number {
    return this.files.size;
  }
}
