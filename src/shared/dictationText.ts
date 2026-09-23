/**
 * Text handling for dictation that both sides need: the main process assembles
 * a preview out of transcribed pieces, and the composer splices the final text
 * into whatever the user already typed. Pure string work, so it lives here and
 * is tested without a DOM or a microphone.
 */

/**
 * Join transcribed pieces into one line. Pieces come from separate Whisper
 * passes over adjacent stretches of audio, each already trimmed of its own
 * noise; an empty piece (a silent stretch) contributes nothing, not a gap.
 */
export function joinTranscript(pieces: readonly string[]): string {
  return pieces
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ');
}

/**
 * Put dictated `text` into `value` at `caret`, and say where the caret goes
 * afterwards.
 *
 * Nothing that was already there is removed. A selection is deliberately not
 * replaced — the caller passes the selection's end — because a stray
 * select-all before clicking the microphone would otherwise throw away a typed
 * draft, and dictation's promise is that what you typed stays.
 *
 * A space is added only where one is missing: after a word the text follows,
 * and before a word the text runs into. Punctuation right after the caret
 * (`foo|.`) is left touching, since that is how a sentence is finished.
 */
export function spliceDictation(value: string, caret: number, text: string): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, value.length));
  const insert = text.trim();
  if (!insert) return { value, caret: at };
  const before = value.slice(0, at);
  const after = value.slice(at);
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const trail = after.length > 0 && !/^[\s.,;:!?)\]}]/.test(after) ? ' ' : '';
  return {
    value: `${before}${lead}${insert}${trail}${after}`,
    caret: before.length + lead.length + insert.length,
  };
}

/** Everything the composer's dictation strip needs to decide what to say. */
export interface DictationView {
  state: 'recording' | 'transcribing';
  /** Whether previews are coming at all (the setting can turn them off). */
  livePreview: boolean;
  recordedMs: number;
  coveredMs: number;
  previewError?: string;
  /** The recording belongs to a conversation the pane has since moved away from. */
  elsewhere?: boolean;
}

/** How far behind the preview may fall before the strip says so. */
export const PREVIEW_LAG_MS = 3000;

/**
 * The strip's heading and, when there is something worth knowing, a second
 * line. `warn` is for the preview failing or falling behind — neither loses
 * anything, since stopping transcribes the whole recording, and the detail
 * says so rather than leaving the user to wonder whether to start again.
 */
export function describeDictation(v: DictationView): { label: string; detail?: string; tone: 'live' | 'busy' | 'warn' } {
  if (v.state === 'transcribing') {
    return {
      label: v.elsewhere ? 'Finishing transcription for the conversation you left…' : 'Finishing transcription…',
      tone: 'busy',
    };
  }
  if (!v.livePreview) {
    return { label: 'Recording', detail: 'Click the microphone to stop and insert the text · Esc discards', tone: 'live' };
  }
  const label = 'Listening — preview, may change';
  if (v.previewError) {
    return {
      label,
      detail: 'Preview stopped working; the whole recording is still transcribed when you stop.',
      tone: 'warn',
    };
  }
  if (v.coveredMs === 0 && v.recordedMs >= PREVIEW_LAG_MS) {
    return { label, detail: 'Starting the recogniser… (the first run after an install is slow)', tone: 'warn' };
  }
  const behind = v.recordedMs - v.coveredMs;
  if (v.coveredMs > 0 && behind >= PREVIEW_LAG_MS) {
    return {
      label,
      detail: `Preview is ${Math.round(behind / 1000)}s behind — nothing is lost; stopping transcribes all of it.`,
      tone: 'warn',
    };
  }
  return { label, tone: 'live' };
}
