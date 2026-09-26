/**
 * Which session list the daemon's reconciler follows, and where a press goes.
 *
 * Two feeds can describe the machine (#74):
 *
 * - **the app**, while it runs: its own decorated list, the one its table
 *   shows. It is the richer one (Codex threads, questions an in-process runner
 *   holds, the archive as the user just left it), so it wins whenever it is
 *   connected and says its list is complete;
 * - **the daemon's own** (`LocalFeed`): the hook log and the session hosts,
 *   which is everything still asking once the app has gone.
 *
 * The switch is what the reconciler sees as one `SessionSnapshot` and one set
 * of `PermissionActions`. It is `ready` only while some feed is: between feeds
 * (the app gone and the local feed still on its first scan) the reconciler
 * leaves the channel alone rather than read an empty list as "nothing is being
 * asked" and close every card.
 *
 * A card keeps its message across a switch: both feeds key an ask the same
 * way (`askKeyFor(session key, request id)`, and the session key comes from
 * the same provider code in both), so the reconciler sees the same ask and
 * does nothing. What only the app could see (a Codex question) is closed when
 * it goes, and posted again when it comes back.
 */
import { Emitter, type Disposable } from '../../core/events';
import type { SessionDTO } from '../../shared/model';
import type { PermissionDecisionOutcome } from '../../ui/actions';
import type { PermissionActions, SessionSnapshot } from '../service';

/** One feed: a list, whether it is complete, and how to apply a press to it. */
export interface FeedSource extends PermissionActions {
  readonly sessions: SessionDTO[];
  readonly ready: boolean;
  /** Fires when the list or `ready` changes. */
  onDidUpdate(listener: () => void): Disposable;
}

export type SourceName = 'app' | 'daemon' | 'none';

export class SourceSwitch implements SessionSnapshot, PermissionActions, Disposable {
  private feeds: { app?: FeedSource; daemon?: FeedSource } = {};
  private subs = new Map<'app' | 'daemon', Disposable>();
  private emitter = new Emitter<void>();
  private last: SourceName = 'none';

  readonly onDidUpdate = (listener: () => void): Disposable => this.emitter.event(listener);

  constructor(private log: (message: string) => void = () => undefined) {}

  /** Attach or detach a feed. The app's comes and goes with its connection. */
  set(name: 'app' | 'daemon', feed: FeedSource | undefined): void {
    this.subs.get(name)?.dispose();
    this.subs.delete(name);
    this.feeds[name] = feed;
    if (feed) this.subs.set(name, feed.onDidUpdate(() => this.changed()));
    this.changed();
  }

  get source(): SourceName {
    if (this.feeds.app?.ready) return 'app';
    if (this.feeds.daemon?.ready) return 'daemon';
    return 'none';
  }

  get ready(): boolean {
    return this.source !== 'none';
  }

  get sessions(): SessionDTO[] {
    return this.active?.sessions ?? [];
  }

  decidePermission(
    key: string,
    behavior: 'allow' | 'deny' | 'always',
    opts?: { expectedRequestId?: string },
  ): Promise<PermissionDecisionOutcome> {
    return this.active?.decidePermission(key, behavior, opts) ?? Promise.resolve('gone');
  }

  answerQuestion(key: string, requestId: string, answers: Record<string, string>): Promise<PermissionDecisionOutcome> {
    return this.active?.answerQuestion(key, requestId, answers) ?? Promise.resolve('gone');
  }

  decidePlan(key: string, requestId: string, approve: boolean, feedback?: string): Promise<PermissionDecisionOutcome> {
    return this.active?.decidePlan(key, requestId, approve, feedback) ?? Promise.resolve('gone');
  }

  dispose(): void {
    for (const s of this.subs.values()) s.dispose();
    this.subs.clear();
    this.emitter.dispose();
  }

  private get active(): FeedSource | undefined {
    const name = this.source;
    return name === 'none' ? undefined : this.feeds[name];
  }

  private changed(): void {
    const now = this.source;
    if (now !== this.last) {
      this.log(`following ${now === 'none' ? 'no feed (waiting for one to be ready)' : `the ${now}'s session list`}`);
      this.last = now;
    }
    this.emitter.fire();
  }
}
