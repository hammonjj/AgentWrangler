import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { joinTranscript } from '../shared/dictationText';

/**
 * Dictation: hold the microphone open, then turn what was said into text for
 * the composer.
 *
 * Two subprocesses, both off the shelf. `ffmpeg` records the microphone as
 * 16 kHz mono signed 16-bit PCM — the only format Whisper accepts without
 * resampling — and `whisper-cli` transcribes it locally. Nothing leaves the
 * machine, and there is no API key.
 *
 * **Live preview.** whisper-cli only transcribes finished files; it has no
 * streaming mode. (`whisper-stream` does, but it captures through SDL, not
 * ffmpeg — a different recording stack with its own device and permission
 * story.) What makes a preview possible anyway is that a warm whisper-cli pass
 * over a few seconds of audio takes ~0.2–0.3 s on Apple silicon with the base
 * model. So ffmpeg writes PCM to a pipe rather than a file, the audio is held
 * in memory, and while recording a loop keeps re-transcribing the *tail* — the
 * audio since the last cut — and reports it as a preview. Once the tail passes
 * ~18 s it is cut at its quietest moment, that stretch is transcribed one last
 * time and frozen, and the tail starts again after it; so a pass never covers
 * more than one Whisper window and its cost stays flat however long you talk.
 *
 * The preview is only ever a preview. Stopping transcribes the **whole**
 * recording in one pass, exactly as before live preview existed, and that is
 * the text the composer receives — so a word split across a cut, or context a
 * short tail lacked, never ends up in the message.
 *
 * Recording in the main process rather than the webview is deliberate. A
 * webview is an iframe with its own permission story, and `getUserMedia` there
 * is a fight with the CSP and the embedder; a child process of the app is just
 * the app asking for the microphone, which macOS already understands. It is
 * also what Claude Code's own dictation does.
 */

export type DictationState = 'idle' | 'recording' | 'transcribing';

export const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const ms = (n: number): number => Math.round((n * SAMPLE_RATE) / 1000);

/** How often the preview loop looks for new audio. */
const TICK_MS = 200;
/** New audio needed since the last pass before another is worth running. */
const PREVIEW_STEP = ms(700);
/** Audio needed before the first pass: less is rarely a whole word. */
const PREVIEW_FIRST = ms(600);
/** How long the tail may grow before it is cut and frozen. Whisper's window is 30 s. */
const COMMIT_AFTER = ms(18000);
/** Where in the tail a cut may fall: not too early, and not on the words still arriving. */
const CUT_MIN = ms(8000);
const CUT_GUARD = ms(1500);
/** A preview heartbeat even when no pass has finished, so the pane can say it is falling behind. */
const HEARTBEAT_MS = 1000;
/** Shorter than this is a click, not a recording: nothing to transcribe. */
const MIN_FINAL = ms(250);
/**
 * RMS (of int16 samples) below which a stretch is treated as silence and not
 * sent to Whisper for a *preview*. Whisper invents words for a quiet room
 * ("Thank you.", "you"), and a preview flickering those in is worse than an
 * empty one. Well under conversational speech (thousands) and above a typical
 * built-in microphone's noise floor (tens). Never applied to the final pass.
 */
const SILENCE_RMS = 180;

/** Where the model is kept when the user has not named one. */
export function defaultModelPath(): string {
  return path.join(os.homedir(), '.cache', 'agent-wrangler', 'whisper', 'ggml-base.en.bin');
}

/**
 * Directories to search for a tool, beyond `PATH`.
 *
 * A GUI app is launched by `launchd`, not by a shell, so it inherits a bare
 * `PATH` — usually `/usr/bin:/bin:/usr/sbin:/sbin` — and every Homebrew binary
 * is invisible to it. This is why "works in my terminal" is not evidence that
 * the app can find something.
 */
const EXTRA_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];

/** First existing, executable match for `names`, searching `PATH` then the Homebrew prefixes. */
export function findTool(names: string[], env: NodeJS.ProcessEnv = process.env, exists = isExecutable): string | undefined {
  const fromPath = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...EXTRA_BIN_DIRS]) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (exists(full)) return full;
    }
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export interface DictationTools {
  ffmpeg: string;
  whisper: string;
  model: string;
}

export interface DictationSettings {
  ffmpegPath?: string;
  whisperPath?: string;
  modelPath?: string;
  /** ffmpeg avfoundation input spec. `:default` is the system input device. */
  inputDevice?: string;
  /** Re-transcribe while recording to show a preview. Defaults to on. */
  livePreview?: boolean;
}

/** What is missing, phrased as the thing the user has to do about it. */
export class DictationSetupError extends Error {
  constructor(
    message: string,
    readonly remedy: 'install-whisper' | 'install-ffmpeg' | 'download-model',
  ) {
    super(message);
  }
}

export function resolveTools(settings: DictationSettings, exists = isExecutable): DictationTools {
  const ffmpeg = settings.ffmpegPath?.trim() || findTool(['ffmpeg'], process.env, exists);
  if (!ffmpeg) {
    throw new DictationSetupError('ffmpeg is needed to record the microphone, and was not found.', 'install-ffmpeg');
  }
  // `whisper-cli` is the current name; `main` is what older whisper.cpp builds
  // installed, and is still what a source build produces.
  const whisper = settings.whisperPath?.trim() || findTool(['whisper-cli', 'whisper-cpp', 'main'], process.env, exists);
  if (!whisper) {
    throw new DictationSetupError('whisper.cpp is needed to transcribe, and was not found.', 'install-whisper');
  }
  const model = settings.modelPath?.trim() || defaultModelPath();
  if (!fs.existsSync(model)) {
    throw new DictationSetupError(`No Whisper model at ${model}.`, 'download-model');
  }
  return { ffmpeg, whisper, model };
}

/**
 * Whisper narrates what it hears when it hears no words: `[BLANK_AUDIO]`,
 * `(dramatic music)`, `[ Silence ]`. Those are descriptions of the room, not
 * things the user said, and dropping one into the composer is worse than
 * dropping nothing. A line that is nothing but a bracketed or parenthesised
 * phrase is always one of these — dictated speech does not come out that way.
 */
export function cleanTranscript(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[[(*][^)\]*]*[\])*]$/.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * ffmpeg args for a Whisper-ready capture: 16 kHz, mono, signed 16-bit,
 * written raw to stdout. A pipe rather than a file is what lets the preview
 * read audio while it is still arriving — a WAV being written has a header
 * that claims zero samples until ffmpeg finishes it.
 */
export function recordArgs(device: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'avfoundation',
    '-i', device,
    '-ar', String(SAMPLE_RATE),
    '-ac', '1',
    // A runaway recorder holding the microphone open is worse than a truncated
    // sentence, so the process has its own ceiling regardless of the UI.
    '-t', '300',
    '-f', 's16le',
    'pipe:1',
  ];
}

export function transcribeArgs(model: string, wav: string): string[] {
  // `-nt` drops timestamps, `-np` drops the progress chatter; what is left on
  // stdout is the text and nothing else.
  return ['-m', model, '-f', wav, '-nt', '-np'];
}

/** A canonical 44-byte-header WAV around raw 16 kHz mono s16le PCM. */
export function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Root-mean-square level of samples `[from, to)` of s16le `pcm`. */
export function rms(pcm: Buffer, from: number, to: number): number {
  const end = Math.min(to, Math.floor(pcm.length / BYTES_PER_SAMPLE));
  if (end <= from) return 0;
  let sum = 0;
  for (let i = from; i < end; i++) {
    const s = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    sum += s * s;
  }
  return Math.sqrt(sum / (end - from));
}

/** Whether no 100 ms stretch of `[from, to)` rises above the silence floor. */
export function isSilent(pcm: Buffer, from: number, to: number, floor = SILENCE_RMS): boolean {
  const frame = ms(100);
  for (let i = from; i < to; i += frame) {
    if (rms(pcm, i, Math.min(i + frame, to)) >= floor) return false;
  }
  return true;
}

/**
 * The sample in `[from, to)` at the centre of its quietest 200 ms — the best
 * place to cut the audio without slicing a word in half. Falls back to `to`
 * when the range is too short to hold a frame.
 */
export function quietestCut(pcm: Buffer, from: number, to: number): number {
  const frame = ms(200);
  const hop = ms(50);
  let best = to;
  let bestLevel = Infinity;
  for (let i = from; i + frame <= to; i += hop) {
    const level = rms(pcm, i, i + frame);
    if (level < bestLevel) {
      bestLevel = level;
      best = i + Math.floor(frame / 2);
    }
  }
  return best;
}

/** What the pane shows while recording. */
export interface DictationPreview {
  /** Provisional text for everything recognised so far. Replaces, never appends to, the last preview. */
  text: string;
  /** Audio recorded so far. */
  recordedMs: number;
  /** How much of it `text` accounts for; the difference is how far the preview is behind. */
  coveredMs: number;
  /** Previews stopped because a pass failed. Recording carries on, and stop still transcribes it all. */
  previewError?: string;
}

export interface DictationListener {
  preview?(p: DictationPreview): void;
  /**
   * The recorder stopped without being asked. `limit` means it reached its
   * five-minute ceiling and the audio is intact — call `stop()` to transcribe
   * it. `failed` means it could not record (microphone refused, device gone);
   * the service is already idle and nothing was kept.
   */
  ended?(reason: { kind: 'limit' } | { kind: 'failed'; message: string }): void;
}

export interface DictationDeps {
  spawn: typeof spawn;
  settings: () => DictationSettings;
  tmpDir?: string;
  /** Overrides for tests; production uses the constants above. */
  timing?: { tickMs?: number; heartbeatMs?: number };
}

interface Recording {
  proc: ChildProcess;
  listener: DictationListener;
  chunks: Buffer[];
  bytes: number;
  flat?: Buffer;
  stderr: string;
  exited: Promise<number>;
  done: boolean;
  preview: boolean;
  /** Frozen transcripts of the audio before `cut`. */
  committed: string[];
  cut: number;
  tail: string;
  /**
   * What the pane is shown, and how much audio it accounts for. Updated only
   * after a tail pass: straight after a cut the old tail is stale but the new
   * one has not been read, and showing the frozen part alone would make the
   * preview shrink and appear to fall seconds behind for a moment.
   */
  shown: string;
  covered: number;
  lastPassEnd: number;
  lastEmit: number;
  previewError?: string;
  /** The in-flight preview transcription, killed on stop or cancel. */
  pass?: ChildProcess;
  passing: boolean;
  timer?: NodeJS.Timeout;
  cancelled: boolean;
}

/**
 * One recording at a time. `start` opens the microphone, `stop` closes it and
 * resolves with the text, `cancel` throws the audio away.
 */
export class DictationService {
  private rec: Recording | undefined;
  private finalProc: ChildProcess | undefined;
  private state: DictationState = 'idle';

  constructor(private deps: DictationDeps) {}

  get current(): DictationState {
    return this.state;
  }

  /** Whether the recording in progress is producing previews. */
  get previewing(): boolean {
    return this.rec?.preview === true;
  }

  /**
   * Open the microphone. `false` means another pane is already recording —
   * there is one microphone, and two panes sharing it would produce one
   * recording that lands in whichever asked for it second.
   *
   * Throws `DictationSetupError` when a tool or the model is missing.
   */
  start(listener: DictationListener = {}): boolean {
    if (this.state !== 'idle') return false;
    const settings = this.deps.settings();
    // All three resolved now, so a missing model fails before the microphone opens.
    const { ffmpeg } = resolveTools(settings);
    const device = settings.inputDevice?.trim() || ':default';
    const proc = this.deps.spawn(ffmpeg, recordArgs(device), { stdio: ['pipe', 'pipe', 'pipe'] });
    const rec: Recording = {
      proc,
      listener,
      chunks: [],
      bytes: 0,
      stderr: '',
      exited: undefined as unknown as Promise<number>,
      done: false,
      preview: settings.livePreview !== false,
      committed: [],
      cut: 0,
      tail: '',
      shown: '',
      covered: 0,
      lastPassEnd: 0,
      lastEmit: Date.now(),
      passing: false,
      cancelled: false,
    };
    // Writing `q` to a recorder that has already exited raises EPIPE on its
    // stdin, and an unhandled stream error takes the whole main process down.
    proc.stdin?.on('error', () => {});
    proc.stdout?.on('data', (d: Buffer) => {
      rec.chunks.push(d);
      rec.bytes += d.length;
      rec.flat = undefined;
    });
    proc.stderr?.on('data', (d: Buffer) => {
      rec.stderr = (rec.stderr + d.toString()).slice(-2000);
    });
    rec.exited = exitOf(proc).then((code) => {
      rec.done = true;
      this.onRecorderExit(rec, code);
      return code;
    });
    this.rec = rec;
    this.state = 'recording';
    this.schedule(rec);
    return true;
  }

  /**
   * Close the microphone and transcribe the whole recording. Resolves with
   * `''` when nothing was said, or when the recording was cancelled while this
   * was in progress — silence is not an error, and the composer simply stays
   * as it was.
   */
  async stop(): Promise<string> {
    const rec = this.rec;
    if (this.state !== 'recording' || !rec) return '';
    this.state = 'transcribing';
    this.stopPreview(rec);

    // `q` on stdin is ffmpeg's own graceful stop: it flushes what it has
    // buffered rather than dropping the last fraction of a second.
    if (!rec.done) {
      try {
        rec.proc.stdin?.write('q');
        rec.proc.stdin?.end();
      } catch {
        rec.proc.kill('SIGINT');
      }
      const guard = setTimeout(() => rec.proc.kill('SIGKILL'), 3000);
      await rec.exited;
      clearTimeout(guard);
    }

    let wav: string | undefined;
    let final: ChildProcess | undefined;
    try {
      if (rec.cancelled) return '';
      const pcm = audioOf(rec);
      if (pcm.length / BYTES_PER_SAMPLE < MIN_FINAL) return '';
      wav = this.tmpWav('final');
      fs.writeFileSync(wav, pcmToWav(pcm));
      let text: string;
      try {
        text = await this.transcribe(wav, (p) => (this.finalProc = final = p));
      } catch (e) {
        if (rec.cancelled) return ''; // killed by cancel: abandoned, not failed
        throw e;
      }
      if (rec.cancelled) return '';
      return cleanTranscript(text);
    } finally {
      if (final && this.finalProc === final) this.finalProc = undefined;
      if (this.rec === rec) this.reset();
      if (wav) fs.rm(wav, { force: true }, () => {});
    }
  }

  /** Stop recording and keep nothing. Safe to call in any state. */
  cancel(): void {
    const rec = this.rec;
    const final = this.finalProc;
    this.reset();
    this.finalProc = undefined;
    final?.kill('SIGKILL');
    if (!rec) return;
    rec.cancelled = true;
    this.stopPreview(rec);
    if (!rec.done) rec.proc.kill('SIGKILL');
  }

  // ---- internals ----

  private reset(): void {
    this.rec = undefined;
    this.state = 'idle';
  }

  private tmpWav(tag: string): string {
    const dir = this.deps.tmpDir ?? os.tmpdir();
    return path.join(dir, `agent-wrangler-dictation-${process.pid}-${Date.now()}-${tag}-${Math.random().toString(36).slice(2, 8)}.wav`);
  }

  private stopPreview(rec: Recording): void {
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = undefined;
    // Its promise settles with a failure the loop ignores, because the loop
    // checks the recording is still live before using any result.
    rec.pass?.kill('SIGKILL');
    rec.pass = undefined;
  }

  private live(rec: Recording): boolean {
    return this.rec === rec && this.state === 'recording' && !rec.cancelled;
  }

  private onRecorderExit(rec: Recording, code: number): void {
    if (!this.live(rec)) return; // asked to stop, or cancelled: expected
    this.stopPreview(rec);
    if (code === 0 && rec.bytes > 0) {
      // The five-minute ceiling. The audio is whole; the owner decides to stop.
      rec.listener.ended?.({ kind: 'limit' });
      return;
    }
    this.reset();
    rec.listener.ended?.({ kind: 'failed', message: recorderFailure(code, rec.stderr, rec.bytes) });
  }

  private schedule(rec: Recording): void {
    if (!this.live(rec)) return;
    rec.timer = setTimeout(() => this.tick(rec), this.deps.timing?.tickMs ?? TICK_MS);
  }

  /**
   * The loop is never blocked on a pass: a slow one (the first-ever run
   * compiles Metal shaders for ~15 s) is exactly when the pane most needs the
   * heartbeat that tells it how far behind the preview has fallen.
   */
  private tick(rec: Recording): void {
    rec.timer = undefined;
    if (!this.live(rec)) return;
    const total = Math.floor(rec.bytes / BYTES_PER_SAMPLE);
    const wantsPass =
      rec.preview &&
      !rec.previewError &&
      !rec.passing &&
      total >= PREVIEW_FIRST &&
      total - rec.lastPassEnd >= PREVIEW_STEP;
    if (wantsPass) {
      void this.runPass(rec, total);
    } else if (rec.preview && Date.now() - rec.lastEmit >= (this.deps.timing?.heartbeatMs ?? HEARTBEAT_MS)) {
      this.emit(rec);
    }
    this.schedule(rec);
  }

  private async runPass(rec: Recording, total: number): Promise<void> {
    rec.passing = true;
    let changed = true;
    try {
      changed = await this.previewPass(rec, total);
    } catch (e) {
      if (this.live(rec)) rec.previewError = (e as Error).message;
    } finally {
      rec.passing = false;
    }
    if (changed && this.live(rec)) this.emit(rec);
  }

  /** One preview transcription: of the tail, or — when it has grown long — of a stretch to freeze. */
  private async previewPass(rec: Recording, total: number): Promise<boolean> {
    const pcm = audioOf(rec);
    const from = rec.cut;
    if (total - from > COMMIT_AFTER) {
      const cut = quietestCut(pcm, from + CUT_MIN, total - CUT_GUARD);
      const text = await this.transcribeSlice(rec, pcm, from, cut);
      if (!this.live(rec)) return false;
      rec.committed.push(text);
      rec.cut = cut;
      rec.tail = '';
      // The new tail has not been looked at yet, so the next tick runs a pass.
      rec.lastPassEnd = cut;
      return false;
    }
    const text = await this.transcribeSlice(rec, pcm, from, total);
    if (!this.live(rec)) return false;
    rec.tail = text;
    rec.shown = joinTranscript([...rec.committed, rec.tail]);
    rec.covered = total;
    rec.lastPassEnd = total;
    return true;
  }

  private async transcribeSlice(rec: Recording, pcm: Buffer, from: number, to: number): Promise<string> {
    if (isSilent(pcm, from, to)) return '';
    const wav = this.tmpWav('preview');
    try {
      fs.writeFileSync(wav, pcmToWav(pcm.subarray(from * BYTES_PER_SAMPLE, to * BYTES_PER_SAMPLE)));
      const raw = await this.transcribe(wav, (p) => (rec.pass = p));
      return cleanTranscript(raw);
    } finally {
      rec.pass = undefined;
      fs.rm(wav, { force: true }, () => {});
    }
  }

  private emit(rec: Recording): void {
    rec.lastEmit = Date.now();
    const total = Math.floor(rec.bytes / BYTES_PER_SAMPLE);
    rec.listener.preview?.({
      text: rec.shown,
      recordedMs: Math.round((total * 1000) / SAMPLE_RATE),
      coveredMs: Math.round((rec.covered * 1000) / SAMPLE_RATE),
      previewError: rec.previewError,
    });
  }

  private async transcribe(wav: string, track: (p: ChildProcess) => void): Promise<string> {
    const { whisper, model } = resolveTools(this.deps.settings());
    const proc = this.deps.spawn(whisper, transcribeArgs(model, wav), { stdio: ['ignore', 'pipe', 'pipe'] });
    track(proc);
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    const code = await exitOf(proc);
    if (code !== 0) throw new Error(`whisper exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`);
    return out;
  }
}

function audioOf(rec: Recording): Buffer {
  if (!rec.flat) {
    const buf = Buffer.concat(rec.chunks);
    // An odd byte means a sample is still half-written; leave it out.
    rec.flat = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1);
    rec.chunks = [rec.flat];
  }
  return rec.flat;
}

/**
 * Why the recorder died, in words that say what to do. ffmpeg's own message is
 * kept on the end, since "Input/output error" is all it says for a refused
 * microphone and a missing device alike.
 */
export function recorderFailure(code: number, stderr: string, bytes: number): string {
  const detail = stderr.trim().split('\n').filter(Boolean).slice(-2).join(' ');
  const hint =
    bytes === 0
      ? 'The microphone could not be opened. If macOS refused access, allow Agent Wrangler under System Settings → Privacy & Security → Microphone; otherwise check the Microphone setting under Dictation.'
      : 'The recording stopped unexpectedly.';
  return detail ? `${hint} (ffmpeg exited ${code}: ${detail})` : `${hint} (ffmpeg exited ${code})`;
}

/**
 * Exit code, from whichever of `close` / `error` comes first. A spawn that
 * fails outright (ENOENT) emits `error` and never `close`.
 */
function exitOf(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      resolve(code);
    };
    proc.on('close', (code, signal) => done(code ?? (signal ? 128 : 0)));
    proc.on('error', () => done(1));
  });
}
