import type { AgentSession } from '../shared/model';
import type { Disposable } from './events';

interface SessionUpdates {
  get(key: string): AgentSession | undefined;
  onDidUpdate(listener: () => void): Disposable;
}
/** Only hook-backed idle transitions may trigger automatic takeover. */
export function waitForAdoptable(store: SessionUpdates, key: string, signal: AbortSignal, confirmEstimated = false): Promise<void> {
  return new Promise((resolve, reject) => {
    let sub: Disposable | undefined;
    const finish = (error?: string) => {
      sub?.dispose();
      signal.removeEventListener('abort', cancel);
      error ? reject(new Error(error)) : resolve();
    };
    const cancel = () => finish('Send cancelled; your draft is preserved.');
    const check = () => {
      if (signal.aborted) return cancel();
      const s = store.get(key);
      if (!s) return finish('Session disappeared; your draft is preserved.');
      if (s.status === 'ended' || s.status === 'waiting' || s.status === 'done') return finish();
      if (s.statusIsEstimated) finish(confirmEstimated ? undefined : 'Status is estimated. Confirm takeover explicitly. Your draft is preserved.');
    };
    sub = store.onDidUpdate(check);
    signal.addEventListener('abort', cancel, { once: true });
    check();
  });
}
