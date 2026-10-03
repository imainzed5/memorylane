// A synchronous fence: React effect cleanup alone can run after an old promise resolves.
export class StaleContentError extends Error {
  constructor() { super("Capture content changed while loading."); }
}

export class ContentRevision {
  private revision = 0;

  current() { return this.revision; }
  isCurrent(revision: number) { return revision === this.revision; }
  invalidate() { return ++this.revision; }

  async read<T>(request: () => Promise<T>): Promise<T> {
    const revision = this.current();
    const result = await request();
    if (!this.isCurrent(revision)) {
      throw new StaleContentError();
    }
    return result;
  }
}
