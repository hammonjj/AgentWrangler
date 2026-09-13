import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Dictation: hold the microphone open, then turn what was said into text for
 * the composer.
 *
 * Two subprocesses, both off the shelf. `ffmpeg` records the microphone to a
 * 16 kHz mono WAV — the only format Whisper accepts without resampling — and
 * `whisper-cli` transcribes that file locally. Nothing leaves the machine, and
 * there is no API key.
 *
 * Recording in the extension host rather than the webview is deliberate. A
 * webview is an iframe with its own permission story, and `getUserMedia` there
 * is a fight with the CSP and the embedder; a child process of the window is
 * just VSCode asking for the microphone, which macOS already understands. It is
 * also what Claude Code's own dictation does.
 */

export type DictationState = 'idle' | 'recording' | 'transcribing';

/** Where the model is kept when the user has not named one. */
export function defaultModelPath(): string {
  return path.join(os.homedir(), '.cache', 'agent-wrangler', 'whisper', 'ggml-base.en.bin');
}

/**
 * Directories to search for a tool, beyond `PATH`.
 *
 * A GUI VSCode is launched by `launchd`, not by a shell, so it inherits a bare
 * `PATH` — usually `/usr/bin:/bin:/usr/sbin:/sbin` — and every Homebrew binary
 * is invisible to it. This is why "works in my terminal" is not evidence that
 * the extension can find something.
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

/** ffmpeg args for a Whisper-ready capture: 16 kHz, mono, signed 16-bit. */
export function recordArgs(device: string, outFile: string): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'avfoundation',
    '-i', device,
    '-ar', '16000',
    '-ac', '1',
    // A runaway recorder holding the microphone open is worse than a truncated
    // sentence, so the process has its own ceiling regardless of the UI.
    '-t', '300',
    '-y', outFile,
  ];
}

export function transcribeArgs(model: string, wav: string): string[] {
  // `-nt` drops timestamps, `-np` drops the progress chatter; what is left on
  // stdout is the text and nothing else.
  return ['-m', model, '-f', wav, '-nt', '-np'];
}

export interface DictationDeps {
  spawn: typeof spawn;
  settings: () => DictationSettings;
  tmpDir?: string;
}

/**
 * One recording at a time. `start` opens the microphone, `stop` closes it and
 * resolves with the text, `cancel` throws the audio away.
 */
export class DictationService {
  private proc: ChildProcess | undefined;
  private wav: string | undefined;
  private state: DictationState = 'idle';

  constructor(private deps: DictationDeps) {}

  get current(): DictationState {
    return this.state;
  }

  /**
   * Open the microphone. `false` means another pane is already recording —
   * there is one microphone, and two panes sharing it would produce one
   * recording that lands in whichever asked for it second.
   *
   * Throws `DictationSetupError` when a tool or the model is missing.
   */
  start(): boolean {
    if (this.state !== 'idle') return false;
    const { ffmpeg, model } = resolveTools(this.deps.settings());
    void model; // resolved now so a missing model fails before the microphone opens
    const dir = this.deps.tmpDir ?? os.tmpdir();
    this.wav = path.join(dir, `agent-wrangler-dictation-${Date.now()}.wav`);
    const device = this.deps.settings().inputDevice?.trim() || ':default';
    this.proc = this.deps.spawn(ffmpeg, recordArgs(device, this.wav), { stdio: ['pipe', 'ignore', 'pipe'] });
    this.state = 'recording';
    return true;
  }

  /**
   * Close the microphone and transcribe. Resolves with `''` when nothing was
   * said — silence is not an error, and the composer simply stays as it was.
   */
  async stop(): Promise<string> {
    if (this.state !== 'recording' || !this.proc || !this.wav) return '';
    const proc = this.proc;
    const wav = this.wav;
    this.state = 'transcribing';

    // `q` on stdin is ffmpeg's own graceful stop: it finishes the file and
    // rewrites the RIFF header with the real length. A signal leaves a WAV
    // claiming zero samples, which Whisper reads as an empty recording.
    try {
      proc.stdin?.write('q');
      proc.stdin?.end();
    } catch {
      proc.kill('SIGINT');
    }
    await once(proc);

    try {
      const text = await this.transcribe(wav);
      return cleanTranscript(text);
    } finally {
      this.reset();
      fs.rm(wav, { force: true }, () => {});
    }
  }

  /** Stop recording and keep nothing. Safe to call in any state. */
  cancel(): void {
    const { proc, wav } = this;
    this.reset();
    proc?.kill('SIGKILL');
    if (wav) fs.rm(wav, { force: true }, () => {});
  }

  private reset(): void {
    this.proc = undefined;
    this.wav = undefined;
    this.state = 'idle';
  }

  private async transcribe(wav: string): Promise<string> {
    const { whisper, model } = resolveTools(this.deps.settings());
    const proc = this.deps.spawn(whisper, transcribeArgs(model, wav), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    const code = await once(proc);
    if (code !== 0) throw new Error(`whisper exited ${code}: ${err.trim().split('\n').slice(-3).join(' ')}`);
    return out;
  }
}

function once(proc: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    proc.on('close', (code) => resolve(code ?? 0));
    proc.on('error', () => resolve(1));
  });
}
