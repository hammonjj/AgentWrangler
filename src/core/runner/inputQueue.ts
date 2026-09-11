/**
 * A push-based async iterable.
 *
 * The Agent SDK takes the conversation's user messages as an `AsyncIterable`
 * it pulls from, but a chat pane produces them when a human presses Enter.
 * This is the adapter between those: `push` from anywhere, and the iterator
 * parks until something arrives. Closing it ends the iteration, which is what
 * closes the CLI's stdin and lets the process exit.
 *
 * Pure: no vscode, no Node, so the runner's plumbing is testable on its own.
 */
export class InputQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private wake?: () => void;
  private closed = false;

  get size(): number {
    return this.queue.length;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  push(value: T): void {
    if (this.closed) return; // a send after close would be silently lost anyway
    this.queue.push(value);
    this.wakeUp();
  }

  /** End the iteration once everything already queued has been handed over. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wakeUp();
  }

  private wakeUp(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
