/**
 * What the browser has to decide for itself about notifications and the
 * microphone (#141), as pure functions so the shim's choices are tested
 * without a browser. No Node or DOM imports: the shim and the daemon's
 * dictation endpoint both use it.
 */

// ---- secure context ----

/**
 * The Notifications API and `getUserMedia` / `MediaRecorder` exist only in a
 * secure context: https, or loopback over http (browsers treat `127.0.0.1`
 * and `localhost` as secure). The LAN address over plain http is not, which
 * is why the LAN listener is https only (#136).
 *
 * Returns why the page cannot use them, in words that say what to do, or
 * undefined when it can.
 */
export function secureContextProblem(env: { isSecureContext: boolean; protocol: string; hostname: string }): string | undefined {
  if (env.isSecureContext) return undefined;
  const host = env.hostname || 'this address';
  return env.protocol === 'http:'
    ? `Notifications and the microphone only work over https or on this Mac itself. ${host} is plain http: pair this device over the https address instead.`
    : 'Notifications and the microphone need a secure connection, and this page is not on one.';
}

// ---- notifications ----

/** `Notification.permission`, plus the browsers that have no `Notification` at all. */
export type NotificationState = 'granted' | 'denied' | 'default' | 'unsupported';

export function isNotificationState(v: unknown): v is NotificationState {
  return v === 'granted' || v === 'denied' || v === 'default' || v === 'unsupported';
}

/**
 * Whether a notice becomes an OS notification in this tab: permission is
 * granted, and the user is not already looking at the page. A visible,
 * focused tab shows nothing; the table and the conversation say it.
 */
export function shouldShowNotice(s: { permission: NotificationState; hidden: boolean; focused: boolean }): boolean {
  return s.permission === 'granted' && (s.hidden || !s.focused);
}

/**
 * Remembers the tags of notices shown lately, so one ask that arrives twice
 * (two events for one prompt, a resend after a reconnect) is shown once. The
 * browser collapses same-tag notifications as well; this also stops the
 * second one re-alerting.
 */
export class NoticeDeduper {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs = 10_000) {}

  /** True the first time `tag` is seen inside the window. */
  first(tag: string, now: number): boolean {
    for (const [t, at] of this.seen) if (now - at >= this.windowMs) this.seen.delete(t);
    if (this.seen.has(tag)) return false;
    this.seen.set(tag, now);
    return true;
  }
}

// ---- dictation in the browser ----

/** Preferred first. Chrome and Firefox record webm/opus; Safari (iOS too) only mp4/AAC. */
export const RECORDER_MIME_PREFERENCE = [
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/webm',
  'audio/ogg;codecs=opus',
] as const;

/** The first of `RECORDER_MIME_PREFERENCE` the browser's `MediaRecorder.isTypeSupported` accepts. */
export function pickRecorderMime(isSupported: (type: string) => boolean): string | undefined {
  for (const type of RECORDER_MIME_PREFERENCE) {
    try {
      if (isSupported(type)) return type;
    } catch {
      // A browser that throws for a type does not support it.
    }
  }
  return undefined;
}

/** Audio the dictation endpoint accepts, by media type (parameters dropped), and the file extension ffmpeg reads it as. */
const AUDIO_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

/** The extension for an upload's `Content-Type`, or undefined for anything that is not audio we take. */
export function audioExtension(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  return AUDIO_EXTENSIONS[base];
}

/** A recording larger than this is refused by the endpoint, and the recorder stops before it. */
export const DICTATION_MAX_BYTES = 10 * 1024 * 1024;
/** The same ceiling the host-mic recorder has: five minutes. */
export const DICTATION_MAX_MS = 5 * 60 * 1000;
/** The custom header every dictation upload carries; with `Origin`, what stops a cross-site form posting audio. */
export const DICTATION_HEADER = 'x-aw-dictation';
/** The recording's length as the client measured it; checked against `DICTATION_MAX_MS`. */
export const DICTATION_DURATION_HEADER = 'x-aw-duration-ms';
export const DICTATION_PATH = '/dictation';
