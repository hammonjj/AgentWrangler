/**
 * Every provider's executor behind one lookup: "is this id a session we run,
 * and if so, its handle". Callers that do not care which agent it is (the
 * conversation pane, the dashboard, remote control) ask this; callers with
 * provider-specific flows (Codex fork, Claude take-over) still go to the
 * executor itself.
 */
import type { Disposable } from '../events';
import type { LaunchRequest, SessionExecutor, SessionHandle, SessionProvider } from './sessionHandle';

export class SessionExecutors {
  private readonly byProvider = new Map<SessionProvider, SessionExecutor>();

  constructor(executors: SessionExecutor[]) {
    for (const e of executors) this.byProvider.set(e.provider, e);
  }

  launch(request: LaunchRequest): Promise<SessionHandle> {
    const executor = this.byProvider.get(request.provider);
    if (!executor) return Promise.reject(new Error(`No executor for ${request.provider} sessions`));
    return executor.launch(request);
  }

  /** The live handle for this id, whichever provider runs it. */
  get(sessionId: string | undefined): SessionHandle | undefined {
    for (const e of this.byProvider.values()) {
      const handle = e.get(sessionId);
      if (handle) return handle;
    }
    return undefined;
  }

  owns(sessionId: string | undefined): boolean {
    return this.get(sessionId) !== undefined;
  }

  list(): SessionHandle[] {
    return [...this.byProvider.values()].flatMap((e) => e.list());
  }

  onDidChange(listener: () => void): Disposable {
    const subs = [...this.byProvider.values()].map((e) => e.onDidChange(listener));
    return { dispose: () => subs.forEach((s) => s.dispose()) };
  }
}
