/**
 * Which remote message mirrors which Agent Wrangler ask.
 *
 * This is the *only* thing remote control persists, and the reason is narrow:
 * a process that did not post a message must still be able to close it. Without
 * the file, a reload orphans live buttons in a channel — the next process would
 * not know they exist, and every press on them would be answered "unknown
 * interaction" forever.
 *
 * So the record is an address and an identity, and nothing else. Whether the
 * permission is open, what the command was, what the session is doing: all of
 * that is Agent Wrangler's, recomputed from the hook marker on every scan, and
 * copying any of it here would create a second answer to a question that
 * already has one.
 *
 * File-based rather than in-process for the same reason `FileUsageCache` is:
 * the next owner may be a different process. Same write discipline too —
 * pid-qualified temp plus rename, and a corrupt file read as empty rather than
 * thrown, since losing the map costs some stale buttons and nothing else.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { RemoteAskKind } from '../shared/remote';
import type { RemoteActor, RemoteMessageRef } from './transport';

/**
 * One mirrored ask.
 *
 * `askKey` is Agent Wrangler's identity for the interaction
 * (`${sessionKey}#${requestId}`) and `interactionId` is the opaque handle the
 * remote service sends back. Both are needed: the first to reconcile against
 * live state, the second to resolve a press.
 */
export interface Mirror {
  interactionId: string;
  askKey: string;
  sessionKey: string;
  requestId: string;
  /**
   * Which sort of ask this message mirrors.
   *
   * The one exception to "the record is an address and an identity, and nothing
   * else", and it earns its place: the closing message is rendered *after* the
   * ask has left live state, so there is nothing left to ask what it was. A
   * question closed as "✅ Allowed" would be the wrong sentence.
   *
   * Absent in records written before this field existed, which `load` fills in
   * as `permission` — the only kind that could have been mirrored then.
   */
  kind: RemoteAskKind;
  ref: RemoteMessageRef;
  /** Hash of what was rendered, so a failover does not re-edit an unchanged message. */
  renderHash: string;
  publishedAtMs: number;
  /**
   * The last press this layer accepted and acted on. Remote-layer state, not a
   * copy of Agent Wrangler's: it records what the remote UI was told to do, and
   * is what lets the closing message say "allowed by X" rather than the vaguer
   * "answered somewhere".
   */
  lastPress?: { actor: RemoteActor; choiceId: string; atMs: number };
}

/** Anything older than this is dropped on load: its message is long gone. */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface MirrorStoreFile {
  version: 1;
  mirrors: Mirror[];
}

/**
 * A record with no `kind` predates the field, and the only kind that could have
 * been mirrored then was a permission. Applied on load rather than on read so
 * nothing downstream has to carry the `?? 'permission'`.
 */
function migrate(m: Mirror): Mirror {
  return m.kind === undefined ? { ...m, kind: 'permission' } : m;
}

function usable(m: unknown, nowMs: number): m is Mirror {
  if (typeof m !== 'object' || m === null) return false;
  const r = m as Partial<Mirror>;
  return (
    typeof r.interactionId === 'string' &&
    typeof r.askKey === 'string' &&
    typeof r.sessionKey === 'string' &&
    typeof r.requestId === 'string' &&
    typeof r.renderHash === 'string' &&
    typeof r.publishedAtMs === 'number' &&
    nowMs - r.publishedAtMs < MAX_AGE_MS &&
    typeof r.ref === 'object' &&
    r.ref !== null &&
    typeof r.ref.channelId === 'string' &&
    typeof r.ref.messageId === 'string'
  );
}

export class MirrorStore {
  private byAskKey = new Map<string, Mirror>();
  private loaded = false;

  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
  ) {}

  /** Read the file. Safe to call repeatedly; only the first does anything. */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(this.file, 'utf8'));
    } catch {
      return; // absent or corrupt: an empty map is the correct recovery
    }
    const list = (parsed as Partial<MirrorStoreFile>)?.mirrors;
    if (!Array.isArray(list)) return;
    const nowMs = this.now();
    for (const m of list) if (usable(m, nowMs)) this.byAskKey.set(m.askKey, migrate(m));
  }

  all(): Mirror[] {
    return [...this.byAskKey.values()];
  }

  get(askKey: string): Mirror | undefined {
    return this.byAskKey.get(askKey);
  }

  byInteractionId(interactionId: string): Mirror | undefined {
    for (const m of this.byAskKey.values()) if (m.interactionId === interactionId) return m;
    return undefined;
  }

  async put(mirror: Mirror): Promise<void> {
    this.byAskKey.set(mirror.askKey, mirror);
    await this.flush();
  }

  async remove(askKey: string): Promise<void> {
    if (!this.byAskKey.delete(askKey)) return;
    await this.flush();
  }

  private async flush(): Promise<void> {
    const body: MirrorStoreFile = { version: 1, mirrors: this.all() };
    // Pid-qualified, so two processes flushing at once cannot interleave into
    // one temp path and rename half of each into place.
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(tmp, JSON.stringify(body), 'utf8');
      await fsp.rename(tmp, this.file);
    } catch {
      // A lost write costs stale buttons after a restart, never correctness:
      // the reconciler reconverges from live state either way.
    }
  }
}
