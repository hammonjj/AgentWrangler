/**
 * Minimal typed event emitter so core/claude modules stay `vscode`-free
 * (unit-testable in plain Node).
 */

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (e: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        // listeners must not break the emitter
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
