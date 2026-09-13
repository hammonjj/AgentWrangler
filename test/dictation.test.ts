import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cleanTranscript,
  DictationService,
  DictationSetupError,
  findTool,
  recordArgs,
  resolveTools,
  transcribeArgs,
  type DictationDeps,
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

describe('DictationService', () => {
  /** A child process that records what was written to stdin and can be closed on demand. */
  function fakeProc(stdout = '') {
    const listeners: Record<string, ((v: unknown) => void)[]> = {};
    const written: string[] = [];
    const proc = {
      written,
      killed: undefined as string | undefined,
      stdin: { write: (s: string) => written.push(s), end: () => {} },
      stdout: { on: (_e: string, cb: (b: Buffer) => void) => cb(Buffer.from(stdout)) },
      stderr: { on: () => {} },
      on(event: string, cb: (v: unknown) => void) {
        (listeners[event] ??= []).push(cb);
        // Close on the next tick so the caller has attached its handler first.
        if (event === 'close') queueMicrotask(() => cb(0));
        return this;
      },
      kill(sig: string) {
        this.killed = sig;
      },
    };
    return proc;
  }

  function service(transcript: string, tools = { ffmpegPath: '/f', whisperPath: '/w', modelPath: __filename }) {
    const spawned: { cmd: string; args: string[] }[] = [];
    let nth = 0;
    const procs: ReturnType<typeof fakeProc>[] = [];
    const svc = new DictationService({
      // The first spawn is the recorder, the second the transcriber.
      spawn: ((cmd: string, args: string[]) => {
        spawned.push({ cmd, args });
        const p = fakeProc(nth++ === 0 ? '' : transcript);
        procs.push(p);
        return p;
      }) as unknown as DictationDeps['spawn'],
      settings: () => tools,
      tmpDir: os.tmpdir(),
    });
    return { svc, spawned, procs };
  }

  it('records then transcribes, and hands back clean text', async () => {
    const { svc, spawned } = service(' Add a mic button.\n');
    expect(svc.start()).toBe(true);
    expect(svc.current).toBe('recording');
    expect(spawned[0].cmd).toBe('/f');

    expect(await svc.stop()).toBe('Add a mic button.');
    expect(spawned[1].cmd).toBe('/w');
    expect(svc.current).toBe('idle');
  });

  it('stops ffmpeg with `q`, not a signal, so the WAV header is finished', async () => {
    // A killed ffmpeg leaves a header claiming zero samples, which Whisper
    // reads as an empty recording — the bug this guards is a silent one.
    const { svc, procs } = service('hello');
    svc.start();
    await svc.stop();
    expect(procs[0].written).toEqual(['q']);
    expect(procs[0].killed).toBeUndefined();
  });

  it('refuses a second recording while one is running', () => {
    const { svc } = service('x');
    expect(svc.start()).toBe(true);
    expect(svc.start()).toBe(false);
  });

  it('can record again after a stop', async () => {
    const { svc } = service('x');
    svc.start();
    await svc.stop();
    expect(svc.start()).toBe(true);
  });

  it('cancel kills the recorder and leaves nothing to transcribe', async () => {
    const { svc, procs, spawned } = service('x');
    svc.start();
    svc.cancel();
    expect(procs[0].killed).toBe('SIGKILL');
    expect(svc.current).toBe('idle');
    // Only the recorder ever ran; no transcription was attempted.
    expect(spawned).toHaveLength(1);
    expect(await svc.stop()).toBe('');
  });

  it('returns empty for a silent recording rather than the noise Whisper invents', async () => {
    const { svc } = service('[BLANK_AUDIO]');
    svc.start();
    expect(await svc.stop()).toBe('');
  });

  it('stopping when nothing is recording is harmless', async () => {
    const { svc } = service('x');
    expect(await svc.stop()).toBe('');
  });
});

describe('argument building', () => {
  it('records what Whisper can read without resampling: 16 kHz mono', () => {
    const args = recordArgs(':default', '/tmp/x.wav');
    expect(args).toContain('avfoundation');
    expect(args.join(' ')).toContain('-ar 16000');
    expect(args.join(' ')).toContain('-ac 1');
    expect(args[args.length - 1]).toBe('/tmp/x.wav');
  });

  it('caps the recording, so a forgotten microphone closes itself', () => {
    expect(recordArgs(':default', '/tmp/x.wav').join(' ')).toContain('-t 300');
  });

  it('passes the chosen input device through', () => {
    expect(recordArgs(':2', '/tmp/x.wav')).toContain(':2');
  });

  it('asks whisper for bare text, which is what makes stdout parseable', () => {
    const args = transcribeArgs('/m/model.bin', '/tmp/x.wav');
    expect(args).toEqual(['-m', '/m/model.bin', '-f', '/tmp/x.wav', '-nt', '-np']);
  });
});
