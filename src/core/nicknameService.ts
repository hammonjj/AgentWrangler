/**
 * A name the user gave a conversation, shown instead of the one it came with.
 *
 * **Why a nickname and not a rename.** A Claude Code session's title is not a
 * field anybody owns: it is derived, in order, from the `ai-title` line the
 * model writes into the transcript, the registry's generated handle, the slug
 * of the first prompt, and finally the first prompt itself. Changing it for
 * real would mean writing into `~/.claude/sessions/<pid>.json` or appending to
 * the transcript — both Claude Code's own files, the second of which *is* the
 * conversation. The repo already declined to rewrite `~/.claude.json` to tidy a
 * dropdown; corrupting a conversation to relabel it is a far worse trade for a
 * far smaller prize. So the name lives here, on our side, where getting it
 * wrong costs nothing.
 *
 * What that buys, beyond safety: it works on ended sessions, on sessions this
 * extension has never run, and it is reversible — clearing the nickname brings
 * the original title back, because the original was never touched.
 *
 * Stored globally, meaning one map rather than one per window; that is not a
 * live channel between windows, so a name set elsewhere appears when this
 * window next reads. Writes apply a single change to freshly-read storage
 * rather than saving this window's whole map, which would drop it.
 */

import type { KeyValueStorage } from './archive';
import { Emitter, type Disposable, type Listener } from './events';

const STORAGE_KEY = 'agentWrangler.nicknames';

/** Long enough for a sentence fragment, short enough not to wreck a 300px row. */
export const MAX_NICKNAME_LENGTH = 60;

export class NicknameService {
  private names = new Map<string, string>();
  private emitter = new Emitter<void>();

  constructor(private storage: KeyValueStorage) {
    this.names = this.read();
  }

  /**
   * Tolerant on purpose: this runs during `activate()`, and a throw here would
   * take the whole extension down over a preference.
   */
  private read(): Map<string, string> {
    const out = new Map<string, string>();
    const raw = this.storage.get<unknown>(STORAGE_KEY, {});
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const clean = typeof value === 'string' ? cleanNickname(value) : undefined;
      if (clean) out.set(key, clean);
    }
    return out;
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get(key: string): string | undefined {
    return this.names.get(key);
  }

  /** Set a nickname, or clear it with an empty/blank one. */
  set(key: string, nickname: string | undefined): void {
    const clean = cleanNickname(nickname);
    if (clean === this.names.get(key)) return;
    // One change applied to what storage says now, not this window's whole map
    // written back — see `PinService.set` for why that distinction matters.
    const merged = this.read();
    if (clean) merged.set(key, clean);
    else merged.delete(key);
    this.names = merged;
    void this.storage.update(STORAGE_KEY, Object.fromEntries(merged));
    this.emitter.fire();
  }
}

/**
 * Collapse whitespace, trim, cap the length, and treat blank as "no nickname".
 *
 * Newlines are flattened rather than rejected because the natural way to get
 * one in is a paste, and refusing a paste teaches nothing; a name is a single
 * line by nature, so making it one is the obvious reading of the intent.
 */
export function cleanNickname(raw: string | undefined): string | undefined {
  const s = raw?.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_NICKNAME_LENGTH) : undefined;
}
