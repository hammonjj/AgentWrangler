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
    const raw = storage.get<Record<string, string>>(STORAGE_KEY, {});
    for (const [key, value] of Object.entries(raw ?? {})) {
      const clean = cleanNickname(value);
      if (clean) this.names.set(key, clean);
    }
  }

  readonly onDidChange = (listener: Listener<void>): Disposable => this.emitter.event(listener);

  get(key: string): string | undefined {
    return this.names.get(key);
  }

  /** Set a nickname, or clear it with an empty/blank one. */
  set(key: string, nickname: string | undefined): void {
    const clean = cleanNickname(nickname);
    if (clean === this.names.get(key)) return;
    if (clean) this.names.set(key, clean);
    else if (!this.names.delete(key)) return;
    void this.storage.update(STORAGE_KEY, Object.fromEntries(this.names));
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
