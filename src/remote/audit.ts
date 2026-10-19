/**
 * Who approved what, from where.
 *
 * Remote control lets someone who is not at the machine act on it, so "an agent
 * pushed to main and nobody remembers agreeing" has to have an answer. One JSON
 * line per event, append-only.
 *
 * It records **ids and tool names, not command bodies**. The channel already
 * holds the command, in redacted form; copying it here would make a second,
 * unredacted place for the same secret to leak from, on disk, forever.
 *
 * The same class keeps the app's own access log (`accessAuditFile`): every
 * mutating action from the panes, `aw` and the app itself, with the principal
 * and `via` that `core/access.ts` attaches. Same rule: ids, never content.
 */
import * as fsSync from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Via } from '../core/access';

export type AuditEvent =
  /** An action passed `authorize` (#123): mutating ones only. See `core/access.ts`. */
  | 'authorized'
  | 'published'
  | 'publish-failed'
  | 'pressed'
  | 'refused-unauthorised'
  /** A browser login link that was unknown, used or expired (#127). No principal. */
  | 'login-failed'
  | 'refused-out-of-scope'
  | 'refused-stale'
  | 'refused-unknown'
  | 'applied'
  | 'apply-failed'
  | 'closed';

export interface AuditRecord {
  event: AuditEvent;
  askKey?: string;
  sessionKey?: string;
  toolName?: string;
  interactionId?: string;
  actorId?: string;
  actorName?: string;
  choiceId?: string;
  outcome?: string;
  detail?: string;
  /**
   * Who acted and through what (#123), on every line that records an action
   * being taken or refused. `actorId` above is the remote service's own user id
   * (a Discord id); `principal` is who that id acts as here.
   */
  principal?: string;
  via?: Via;
  /** The `authorize` action name, and what it was about, by id. */
  action?: string;
  resource?: { kind: string; id: string };
  /** Attribution only, never identity: which paired device, which tab. */
  deviceId?: string;
  connectionId?: string;
}

/** Rotate at 2 MB, keeping one previous file. Small: these lines are ~200 bytes. */
const MAX_BYTES = 2 * 1024 * 1024;

export interface AuditLog {
  write(record: AuditRecord): void;
}

export class FileAuditLog implements AuditLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private file: string,
    private now: () => number = () => Date.now(),
  ) {}

  /**
   * Fire and forget, but serialised: appends are chained so two events in the
   * same tick cannot interleave into one line. Never throws — an audit failure
   * must not take down the thing it is auditing.
   */
  write(record: AuditRecord): void {
    const line = `${JSON.stringify({ ts: new Date(this.now()).toISOString(), ...record })}\n`;
    this.queue = this.queue.then(() => this.append(line)).catch(() => undefined);
  }

  /** For tests and for shutdown: resolves once everything queued has landed. */
  async drain(): Promise<void> {
    await this.queue;
  }

  private async append(line: string): Promise<void> {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await this.rotateIfLarge();
      await fsp.appendFile(this.file, line, 'utf8');
    } catch {
      // Nothing to do about it, and nothing worth breaking over.
    }
  }

  private async rotateIfLarge(): Promise<void> {
    try {
      if ((await fsp.stat(this.file)).size < MAX_BYTES) return;
      await fsp.rename(this.file, `${this.file}.1`);
    } catch {
      // Absent, or already rotated by another process.
    }
  }

  /** Synchronous existence check, for the "show me the log" command. */
  get path(): string {
    return this.file;
  }

  get exists(): boolean {
    return fsSync.existsSync(this.file);
  }
}

/** For tests, and for a host with nowhere to write. */
export class MemoryAuditLog implements AuditLog {
  readonly records: AuditRecord[] = [];
  write(record: AuditRecord): void {
    this.records.push(record);
  }
  events(): AuditEvent[] {
    return this.records.map((r) => r.event);
  }
}
