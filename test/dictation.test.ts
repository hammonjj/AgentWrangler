import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanTranscript,
  DictationService,
  DictationSetupError,
  findTool,
  isSilent,
  pcmToWav,
  quietestCut,
  recordArgs,
  recorderFailure,
  resolveTools,
  rms,
  SAMPLE_RATE,
  transcribeArgs,
  type DictationDeps,
  type DictationPreview,
  type DictationSettings,
} from '../src/core/dictation';

/** Stands in for the filesystem: these paths exist and are executable, nothing else is. */
function present(...files: string[]) {
  const set = new Set(files);
  return (f: string) => set.has(f);
}

describe('findTool', () => {
  it('prefers PATH over the Homebrew prefixes', () => {
    const env = { PATH: ['/custom/bin', '/usr/bin'].join(path.delimiter) };
    const exists = present('/custom/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg');
    expect(findTool(['ffmpeg'], env, exists)).toBe('/custom/bin/ffmpeg');
  });

  it('finds Homebrew tools when PATH is the bare one a GUI VSCode inherits', () => {
    // launchd starts VSCode with /usr/bin:/bin:/usr/sbin:/sbin, so without this
    // fallback every Homebrew binary is invisible to the extension host.
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
    expect(findTool(['whisper-cli'], env, present('/opt/homebrew/bin/whisper-cli'))).toBe(
      '/opt/homebrew/bin/whisper-cli',
    );
  });

  it('tries the names in order, so a current build wins over a legacy one', () => {
    const env = { PATH: '/usr/bin' };
    const exists = present('/usr/bin/whisper-cli', '/usr/bin/main');
    expect(findTool(['whisper-cli', 'whisper-cpp', 'main'], env, exists)).toBe('/usr/bin/whisper-cli');
  });

  it('is undefined when nothing matches', () => {
    expect(findTool(['nope'], { PATH: '/usr/bin' }, present())).toBeUndefined();
  });

  it('survives an unset PATH', () => {
    expect(findTool(['ffmpeg'], {}, present('/opt/homebrew/bin/ffmpeg'))).toBe('/opt/homebrew/bin/ffmpeg');
  });
});

describe('resolveTools', () => {
  const exists = present('/opt/homebrew/bin/ffmpeg', '/opt/homebrew/bin/whisper-cli');

  it('names the missing piece so the caller can offer the right fix', () => {
    expect(() => resolveTools({}, present())).toThrow(DictationSetupError);
    try {
      resolveTools({}, present());
    } catch (e) {
      expect((e as DictationSetupError).remedy).toBe('install-ffmpeg');
    }

    try {
      resolveTools({}, present('/opt/homebrew/bin/ffmpeg'));
    } catch (e) {
      expect((e as DictationSetupError).remedy).toBe('install-whisper');
    }
  });

  it('asks for the model once the tools are there', () => {
    // No model file is written, so this always falls through to the last check.
    try {
      resolveTools({ modelPath: '/Users/test/nope.bin' }, exists);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as DictationSetupError).remedy).toBe('download-model');
    }
  });

  it('takes a configured path ahead of any search', () => {
    try {
      resolveTools({ ffmpegPath: '/my/ffmpeg', whisperPath: '/my/whisper', modelPath: '/no/such.bin' }, present());
      expect.unreachable('should have thrown');
    } catch (e) {
      // It got past both tools without them existing on disk, so the setting won.
      expect((e as DictationSetupError).remedy).toBe('download-model');
    }
  });
});

describe('cleanTranscript', () => {
  it('keeps what was actually said, on one line', () => {
    expect(cleanTranscript('\n Add a mic button\n to the composer.  \n')).toBe('Add a mic button to the composer.');
  });

  it('drops the noises Whisper narrates when nobody speaks', () => {
    // Every one of these is what a silent room transcribes as, and every one of
    // them would otherwise be pasted into the composer as if it were dictation.
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript(' (dramatic music)')).toBe('');
    expect(cleanTranscript('[ Silence ]')).toBe('');
    expect(cleanTranscript('*clears throat*')).toBe('');
  });

  it('keeps a line that merely contains brackets', () => {
    expect(cleanTranscript('call foo (the helper) twice')).toBe('call foo (the helper) twice');
  });

  it('drops a noise line but keeps the speech around it', () => {
    expect(cleanTranscript('[BLANK_AUDIO]\nrun the tests\n(music)')).toBe('run the tests');
  });

  it('is empty for an empty recording rather than throwing', () => {
    expect(cleanTranscript('')).toBe('');
    expect(cleanTranscript('   \n  \n')).toBe('');
  });
});

// ---- audio helpers ----

const samples = (ms: number) => Math.round((ms * SAMPLE_RATE) / 1000);

/** A 440 Hz tone: loud enough to count as speech for the silence gate. */
function tone(ms: number, amp = 6000): Buffer {
  const n = samples(ms);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE)), i * 2);
  return b;
}
const silence = (ms: number) => Buffer.alloc(samples(ms) * 2);

describe('audio helpers', () => {
  it('wraps PCM in a WAV header Whisper reads as 16 kHz mono 16-bit', () => {
    const wav = pcmToWav(tone(500));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(samples(500) * 2); // the real length, not zero
    expect(wav.length).toBe(44 + samples(500) * 2);
  });

  it('measures level, and calls a quiet room silent', () => {
    expect(rms(silence(100), 0, samples(100))).toBe(0);
    expect(rms(tone(100), 0, samples(100))).toBeGreaterThan(3000);
    expect(isSilent(silence(1000), 0, samples(1000))).toBe(true);
    expect(isSilent(Buffer.concat([silence(800), tone(200)]), 0, samples(1000))).toBe(false);
  });

  it('cuts in the pause between words, not through one', () => {
    const pcm = Buffer.concat([tone(3000), silence(400), tone(3000)]);
    const cut = quietestCut(pcm, 0, samples(6400));
    expect(cut).toBeGreaterThan(samples(3000));
    expect(cut).toBeLessThan(samples(3400));
  });
});

describe('recorderFailure', () => {
  it('points at the microphone permission when nothing was ever recorded', () => {
    const msg = recorderFailure(1, 'Input/output error\n', 0);
    expect(msg).toContain('Privacy & Security');
    expect(msg).toContain('Input/output error');
  });

  it('says the recording stopped when some audio had arrived', () => {
    expect(recorderFailure(1, '', 3200)).toContain('stopped unexpectedly');
  });
});

// ---- the service, against fake processes ----

/** Enough of a ChildProcess for the service: streams, events, kill. */
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  killed: string | undefined;
  closed = false;
  stdin = Object.assign(new EventEmitter(), {
    write: (s: string) => {
      this.written.push(s);
      if (this.onQuit) this.onQuit();
      return true;
    },
    end: () => {},
  });
  onQuit?: () => void;

  close(code: number | null, signal: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => this.emit('close', code, signal), 0);
  }

  kill(sig: string): boolean {
    this.killed = sig;
    this.close(null, sig);
    return true;
  }
}

interface WhisperCall {
  proc: FakeProc;
  wav: string;
  /** Audio duration of the file it was given, in ms. */
  durationMs: number;
}

function harness(opts: {
  settings?: Partial<DictationSettings>;
  /** What whisper prints for a file of this duration. Returning undefined holds the process open. */
  whisper?: (durationMs: number, call: number) => string | undefined;
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-dict-test-'));
  const recorders: FakeProc[] = [];
  const whispers: WhisperCall[] = [];
  const reply = opts.whisper ?? (() => ' Hello there.\n');
  const svc = new DictationService({
    spawn: ((cmd: string, args: string[]) => {
      const p = new FakeProc();
      if (cmd === '/f') {
        // ffmpeg's graceful stop: `q` flushes and exits 0.
        p.onQuit = () => p.close(0);
        recorders.push(p);
        return p;
      }
      const wav = args[args.indexOf('-f') + 1];
      const bytes = fs.statSync(wav).size - 44;
      const durationMs = Math.round((bytes / 2 / SAMPLE_RATE) * 1000);
      whispers.push({ proc: p, wav, durationMs });
      const out = reply(durationMs, whispers.length);
      if (out !== undefined) {
        setTimeout(() => {
          p.stdout.emit('data', Buffer.from(out));
          p.close(0);
        }, 0);
      }
      return p;
    }) as unknown as DictationDeps['spawn'],
    settings: () => ({ ffmpegPath: '/f', whisperPath: '/w', modelPath: __filename, ...opts.settings }),
    tmpDir: tmp,
    timing: { tickMs: 2, heartbeatMs: 20 },
  });
  const feed = (pcm: Buffer) => recorders[recorders.length - 1].stdout.emit('data', pcm);
  const leftovers = () => fs.readdirSync(tmp);
  return { svc, recorders, whispers, feed, tmp, leftovers };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('DictationService', () => {
  let cleanup: string[] = [];
  beforeEach(() => {
    cleanup = [];
  });
  afterEach(() => {
    for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true });
  });
  const make = (o?: Parameters<typeof harness>[0]) => {
    const h = harness(o);
    cleanup.push(h.tmp);
    return h;
  };

  it('records from a pipe, then transcribes the whole recording on stop', async () => {
    const h = make({ settings: { livePreview: false } });
    expect(h.svc.start()).toBe(true);
    expect(h.svc.current).toBe('recording');
    expect(h.recorders).toHaveLength(1);
    h.feed(tone(1000));
    h.feed(tone(500));

    expect(await h.svc.stop()).toBe('Hello there.');
    expect(h.recorders[0].written).toEqual(['q']); // graceful, never a signal
    expect(h.recorders[0].killed).toBeUndefined();
    expect(h.whispers).toHaveLength(1);
    expect(h.whispers[0].durationMs).toBe(1500); // every sample, in one pass
    expect(h.svc.current).toBe('idle');
    await until(() => h.leftovers().length === 0);
  });

  it('shows a preview while recording, and replaces it as the tail is re-read', async () => {
    const previews: DictationPreview[] = [];
    const h = make({ whisper: (d) => (d < 1500 ? 'add a' : 'add a test') });
    h.svc.start({ preview: (p) => previews.push(p) });
    h.feed(tone(1000));
    await until(() => previews.some((p) => p.text === 'add a'));
    h.feed(tone(1000));
    await until(() => previews.some((p) => p.text === 'add a test'));
    const last = previews[previews.length - 1];
    // A replacement, not an append: the revised text is not "add a add a test".
    expect(last.text).toBe('add a test');
    expect(last.coveredMs).toBe(2000);
    expect(last.recordedMs).toBe(2000);
    await h.svc.stop();
  });

  it('never presents the preview as the result: stop runs its own pass', async () => {
    const h = make({ whisper: (_d, call) => (call === 1 ? 'provisional words' : 'Final words.') });
    const previews: DictationPreview[] = [];
    h.svc.start({ preview: (p) => previews.push(p) });
    h.feed(tone(1000));
    await until(() => previews.some((p) => p.text === 'provisional words'));
    expect(await h.svc.stop()).toBe('Final words.');
  });

  it('does not ask Whisper about silence during the preview', async () => {
    // Whisper invents "Thank you." for a quiet room; a preview must not flicker it in.
    const previews: DictationPreview[] = [];
    const h = make({ whisper: () => 'Thank you.' });
    h.svc.start({ preview: (p) => previews.push(p) });
    h.feed(silence(1500));
    await until(() => previews.some((p) => p.coveredMs === 1500));
    expect(h.whispers).toHaveLength(0);
    expect(previews[previews.length - 1].text).toBe('');
    h.svc.cancel();
  });

  it('freezes a long tail at a pause and keeps previewing after it', async () => {
    const previews: DictationPreview[] = [];
    const h = make({ whisper: (d) => `[${Math.round(d / 1000)}s]x` });
    h.svc.start({ preview: (p) => previews.push(p) });
    // 10 s of speech, a pause, 10 s more: past the 18 s tail limit.
    h.feed(Buffer.concat([tone(10000), silence(500), tone(10000)]));
    await until(() => h.whispers.length >= 2);
    await until(() => previews.some((p) => p.text.split(' ').length === 2));
    const commit = h.whispers.find((w) => w.durationMs < 20500)!;
    // Cut inside the pause, so the frozen stretch is the first sentence.
    expect(commit.durationMs).toBeGreaterThanOrEqual(10000);
    expect(commit.durationMs).toBeLessThanOrEqual(10500);
    const text = previews[previews.length - 1].text;
    expect(text).toBe('[10s]x [10s]x');
    await h.svc.stop();
    // The final pass still covers all of it.
    expect(h.whispers[h.whispers.length - 1].durationMs).toBe(20500);
  });

  it('says how far behind the preview is when a pass is slow', async () => {
    const previews: DictationPreview[] = [];
    // First pass hangs, as the first-ever Metal compile does.
    const h = make({ whisper: () => undefined });
    h.svc.start({ preview: (p) => previews.push(p) });
    h.feed(tone(1000));
    await until(() => h.whispers.length === 1);
    h.feed(tone(3000));
    await until(() => previews.some((p) => p.recordedMs === 4000));
    const p = previews[previews.length - 1];
    expect(p.coveredMs).toBe(0);
    expect(p.recordedMs - p.coveredMs).toBe(4000);
    h.svc.cancel();
    expect(h.whispers[0].proc.killed).toBe('SIGKILL');
  });

  it('keeps recording when a preview pass fails, and says so', async () => {
    const previews: DictationPreview[] = [];
    const h = make({ whisper: (_d, call) => (call === 1 ? undefined : 'Hello there.') });
    h.svc.start({ preview: (p) => previews.push(p) });
    h.feed(tone(1000));
    await until(() => h.whispers.length === 1);
    h.whispers[0].proc.kill('SIGSEGV'); // any non-zero exit
    await until(() => previews.some((p) => p.previewError !== undefined));
    expect(h.svc.current).toBe('recording');
    // No further preview passes after a failure; the final one still runs.
    expect(await h.svc.stop()).toBe('Hello there.');
    expect(h.whispers).toHaveLength(2);
  });

  it('returns nothing for an empty recording without running Whisper', async () => {
    const h = make();
    h.svc.start();
    expect(await h.svc.stop()).toBe('');
    expect(h.whispers).toHaveLength(0);
    expect(h.svc.current).toBe('idle');
  });

  it('survives an immediate start then stop', async () => {
    const h = make();
    h.svc.start();
    const text = h.svc.stop();
    expect(h.svc.current).toBe('transcribing');
    expect(await text).toBe('');
    expect(h.svc.start()).toBe(true); // and can go again straight away
    h.svc.cancel();
  });

  it('returns empty for what Whisper narrates over silence', async () => {
    const h = make({ settings: { livePreview: false }, whisper: () => '[BLANK_AUDIO]' });
    h.svc.start();
    h.feed(silence(1000));
    expect(await h.svc.stop()).toBe('');
  });

  it('reports a refused microphone and goes idle', async () => {
    const h = make();
    const ended: unknown[] = [];
    h.svc.start({ ended: (r) => ended.push(r) });
    h.recorders[0].stderr.emit('data', Buffer.from('Input/output error\n'));
    h.recorders[0].close(1);
    await until(() => ended.length === 1);
    expect(ended[0]).toMatchObject({ kind: 'failed' });
    expect((ended[0] as { message: string }).message).toContain('Microphone');
    expect(h.svc.current).toBe('idle');
    expect(await h.svc.stop()).toBe('');
  });

  it('hands the audio over when the five-minute ceiling stops ffmpeg', async () => {
    const h = make({ settings: { livePreview: false } });
    const ended: unknown[] = [];
    h.svc.start({ ended: (r) => ended.push(r) });
    h.feed(tone(1000));
    h.recorders[0].close(0);
    await until(() => ended.length === 1);
    expect(ended[0]).toEqual({ kind: 'limit' });
    expect(await h.svc.stop()).toBe('Hello there.');
    expect(h.recorders[0].written).toEqual([]); // already exited, nothing to tell it
  });

  it('refuses a second recording while one is running', () => {
    const h = make();
    expect(h.svc.start()).toBe(true);
    expect(h.svc.start()).toBe(false);
    h.svc.cancel();
  });

  it('cancel kills everything, keeps nothing and leaves no files', async () => {
    const h = make({ whisper: () => undefined });
    h.svc.start();
    h.feed(tone(1000));
    await until(() => h.whispers.length === 1); // a preview pass in flight
    h.svc.cancel();
    expect(h.recorders[0].killed).toBe('SIGKILL');
    expect(h.whispers[0].proc.killed).toBe('SIGKILL');
    expect(h.svc.current).toBe('idle');
    expect(await h.svc.stop()).toBe('');
    await until(() => h.leftovers().length === 0);
  });

  it('cancel during the final pass abandons it rather than delivering text', async () => {
    const h = make({ settings: { livePreview: false }, whisper: () => undefined });
    h.svc.start();
    h.feed(tone(1000));
    const text = h.svc.stop();
    await until(() => h.whispers.length === 1);
    h.svc.cancel();
    expect(await text).toBe('');
    expect(h.whispers[0].proc.killed).toBe('SIGKILL');
    await until(() => h.leftovers().length === 0);
  });

  it('runs no preview passes when live preview is off', async () => {
    const previews: DictationPreview[] = [];
    const h = make({ settings: { livePreview: false } });
    h.svc.start({ preview: (p) => previews.push(p) });
    expect(h.svc.previewing).toBe(false);
    h.feed(tone(2000));
    await new Promise((r) => setTimeout(r, 60));
    expect(h.whispers).toHaveLength(0);
    expect(previews).toHaveLength(0);
    await h.svc.stop();
  });
});

describe('argument building', () => {
  it('records what Whisper can read without resampling: 16 kHz mono s16le, to a pipe', () => {
    const args = recordArgs(':default');
    expect(args).toContain('avfoundation');
    expect(args.join(' ')).toContain('-ar 16000');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args.join(' ')).toContain('-f s16le');
    expect(args[args.length - 1]).toBe('pipe:1');
  });

  it('caps the recording, so a forgotten microphone closes itself', () => {
    expect(recordArgs(':default').join(' ')).toContain('-t 300');
  });

  it('passes the chosen input device through', () => {
    expect(recordArgs(':2')).toContain(':2');
  });

  it('asks whisper for bare text, which is what makes stdout parseable', () => {
    const args = transcribeArgs('/m/model.bin', '/tmp/x.wav');
    expect(args).toEqual(['-m', '/m/model.bin', '-f', '/tmp/x.wav', '-nt', '-np']);
  });
});
