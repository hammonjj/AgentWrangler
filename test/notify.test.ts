/**
 * Notifications and dictation for browsers (#141): the routing matrix, tag
 * dedupe, the shell messages, the shim's pure decisions, and the daemon half
 * of browser dictation against fake processes.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClientRegistry, channelFromDialogs, type ClientChannel } from '../src/core/clients';
import { convertArgs, DictationService, DictationSetupError, SAMPLE_RATE, type DictationDeps } from '../src/core/dictation';
import { createShellChannel } from '../src/core/web/shellChannel';
import type { HostDialogs, HostNotice } from '../src/host/hostServices';
import { parseShellNotice, parseShellToHost, type HostToShell } from '../src/shared/shellProtocol';
import {
  NoticeDeduper,
  audioExtension,
  pickRecorderMime,
  secureContextProblem,
  shouldShowNotice,
} from '../src/shared/webCapabilities';

// ---- routing ----

function browserTab(id: string, permission: 'granted' | 'default' | 'denied' | 'unsupported' = 'granted') {
  const sent: HostToShell[] = [];
  const shell = createShellChannel({ connectionId: id, post: (e) => sent.push(e.body), conversation: () => undefined });
  shell.receive({ type: 'notifications', permission });
  return { shell, sent, notices: () => sent.filter((b) => b.type === 'notify') };
}

function windowClient(open = true): ClientChannel {
  const dialogs = {} as HostDialogs;
  return channelFromDialogs({ connectionId: 'window', dialogs, isOpen: () => open, navigate: () => undefined });
}

function rig() {
  const registry = new ClientRegistry({ log: () => undefined });
  const native: HostNotice[] = [];
  let clock = 1_000_000;
  const notify = registry.notifier((n) => native.push(n), () => clock);
  return { registry, native, notify, advance: (ms: number) => (clock += ms) };
}

const notice = (tag: string, extra: Partial<HostNotice> = {}): HostNotice => ({ title: 'T', body: 'B', tag, sessionKey: 'claude:s1', ...extra });

describe('notice routing', () => {
  it('no clients: the host notifies', () => {
    const { notify, native } = rig();
    notify(notice('a'));
    expect(native).toHaveLength(1);
  });

  it('the window only (no browser): the host notifies, as before', () => {
    const { registry, notify, native } = rig();
    registry.register(windowClient());
    notify(notice('a'));
    expect(native).toHaveLength(1);
  });

  it('a browser tab with permission: it is sent the notice and the host stays quiet', () => {
    const { registry, notify, native } = rig();
    const tab = browserTab('web-1');
    registry.register(tab.shell.channel);
    notify(notice('a'));
    expect(native).toEqual([]);
    expect(tab.notices()).toEqual([{ type: 'notify', title: 'T', body: 'B', tag: 'a', sessionKey: 'claude:s1' }]);
  });

  it('a hidden or visible tab alike is sent it (the tab decides whether to show it); the window beside it changes nothing', () => {
    const { registry, notify, native } = rig();
    registry.register(windowClient());
    const visible = browserTab('web-1');
    const hidden = browserTab('web-2');
    registry.register(visible.shell.channel);
    registry.register(hidden.shell.channel);
    notify(notice('a'));
    expect(visible.notices()).toHaveLength(1);
    expect(hidden.notices()).toHaveLength(1);
    expect(native).toEqual([]);
  });

  it('every device gets its own copy', () => {
    const { registry, notify } = rig();
    const tabs = ['web-1', 'web-2', 'web-3'].map((id) => browserTab(id));
    for (const t of tabs) registry.register(t.shell.channel);
    notify(notice('a'));
    expect(tabs.map((t) => t.notices().length)).toEqual([1, 1, 1]);
  });

  it('a tab that has not granted permission is not a place for it: the host notifies', () => {
    const { registry, notify, native } = rig();
    for (const p of ['default', 'denied', 'unsupported'] as const) registry.register(browserTab(`web-${p}`, p).shell.channel);
    notify(notice('a'));
    expect(native).toHaveLength(1);
  });

  it('a tab that has not reported at all is not a place for it', () => {
    const { registry, notify, native } = rig();
    const silent = createShellChannel({ connectionId: 'web-9', post: () => undefined, conversation: () => undefined });
    registry.register(silent.channel);
    notify(notice('a'));
    expect(native).toHaveLength(1);
  });

  it('a tab that disconnects stops being one: back to the host', () => {
    const { registry, notify, native, advance } = rig();
    const tab = browserTab('web-1');
    const reg = registry.register(tab.shell.channel);
    notify(notice('a'));
    expect(native).toEqual([]);
    reg.dispose();
    tab.shell.dispose();
    advance(60_000);
    notify(notice('b'));
    expect(native).toHaveLength(1);
  });

  it('a revoked permission is honoured at once', () => {
    const { registry, notify, native } = rig();
    const tab = browserTab('web-1');
    registry.register(tab.shell.channel);
    tab.shell.receive({ type: 'notifications', permission: 'denied' });
    notify(notice('a'));
    expect(native).toHaveLength(1);
    expect(tab.notices()).toEqual([]);
  });

  it('collapses the same tag arriving twice, and lets it through again later', () => {
    const { registry, notify, native, advance } = rig();
    const tab = browserTab('web-1');
    registry.register(tab.shell.channel);
    notify(notice('ask-1'));
    notify(notice('ask-1'));
    expect(tab.notices()).toHaveLength(1);
    notify(notice('ask-2'));
    expect(tab.notices()).toHaveLength(2);
    advance(10_000);
    notify(notice('ask-1'));
    expect(tab.notices()).toHaveLength(3);
    expect(native).toEqual([]);
  });

  it('collapses duplicates to the host too', () => {
    const { notify, native } = rig();
    notify(notice('a'));
    notify(notice('a'));
    expect(native).toHaveLength(1);
  });

  it('a notice with no tag goes to the host (a browser needs a tag to collapse on)', () => {
    const { registry, notify, native } = rig();
    registry.register(browserTab('web-1').shell.channel);
    notify({ title: 'T', body: 'B' });
    expect(native).toHaveLength(1);
  });

  it('a throwing tab does not stop the others', () => {
    const { registry, notify } = rig();
    const bad: ClientChannel = {
      connectionId: 'bad',
      isOpen: true,
      canNotify: true,
      notify: () => {
        throw new Error('boom');
      },
      prompt: async () => undefined,
      toast: () => undefined,
      navigate: () => undefined,
    };
    const good = browserTab('web-1');
    registry.register(bad);
    registry.register(good.shell.channel);
    notify(notice('a'));
    expect(good.notices()).toHaveLength(1);
  });

  it('a tapped notification (shell `show`) points that tab at the session', () => {
    const sent: HostToShell[] = [];
    const shown: string[] = [];
    const shell = createShellChannel({
      connectionId: 'web-1',
      post: (e) => sent.push(e.body),
      conversation: () => ({ show: (k) => shown.push(k), showSession: () => undefined, showDetail: () => undefined }),
    });
    shell.receive({ type: 'show', key: 'claude:s1' });
    expect(shown).toEqual(['claude:s1']);
    expect(sent).toEqual([{ type: 'navigate', target: 'conversation', key: 'claude:s1' }]);
  });
});

// ---- the wire ----

describe('shell messages', () => {
  it('parses what a tab reports', () => {
    expect(parseShellToHost({ type: 'notifications', permission: 'granted' })).toEqual({ type: 'notifications', permission: 'granted' });
    expect(parseShellToHost({ type: 'notifications', permission: 'maybe' })).toBeUndefined();
    expect(parseShellToHost({ type: 'notifications' })).toBeUndefined();
    expect(parseShellToHost({ type: 'show', key: 'claude:s1' })).toEqual({ type: 'show', key: 'claude:s1' });
    expect(parseShellToHost({ type: 'show', key: '' })).toBeUndefined();
    expect(parseShellToHost({ type: 'show', key: 5 })).toBeUndefined();
    expect(parseShellToHost({ type: 'show', key: 'x'.repeat(2000) })).toBeUndefined();
  });

  it('parses a notify, bounding its text', () => {
    expect(parseShellNotice({ type: 'notify', title: 'T', body: 'B', tag: 'a', sessionKey: 'k' })).toEqual({
      type: 'notify',
      title: 'T',
      body: 'B',
      tag: 'a',
      sessionKey: 'k',
    });
    expect(parseShellNotice({ type: 'notify', title: 'T', body: 'B', tag: 'a' })).toEqual({ type: 'notify', title: 'T', body: 'B', tag: 'a' });
    expect(parseShellNotice({ type: 'notify', title: 'x'.repeat(900), body: 'B', tag: 'a' })!.title).toHaveLength(500);
  });

  it('rejects a notify that is not one', () => {
    expect(parseShellNotice(undefined)).toBeUndefined();
    expect(parseShellNotice({ type: 'toast', title: 'T', body: 'B', tag: 'a' })).toBeUndefined();
    expect(parseShellNotice({ type: 'notify', title: 'T', body: 'B' })).toBeUndefined();
    expect(parseShellNotice({ type: 'notify', title: 'T', body: 'B', tag: '' })).toBeUndefined();
    expect(parseShellNotice({ type: 'notify', title: 1, body: 'B', tag: 'a' })).toBeUndefined();
    expect(parseShellNotice({ type: 'notify', title: 'T', body: 'B', tag: 'a', sessionKey: 7 })).toBeUndefined();
  });
});

// ---- the shim's decisions ----

describe('shouldShowNotice', () => {
  it('shows only with permission and a tab the user is not looking at', () => {
    expect(shouldShowNotice({ permission: 'granted', hidden: true, focused: false })).toBe(true);
    expect(shouldShowNotice({ permission: 'granted', hidden: false, focused: false })).toBe(true); // visible but another window has focus
    expect(shouldShowNotice({ permission: 'granted', hidden: true, focused: true })).toBe(true);
    expect(shouldShowNotice({ permission: 'granted', hidden: false, focused: true })).toBe(false);
    for (const permission of ['default', 'denied', 'unsupported'] as const) {
      expect(shouldShowNotice({ permission, hidden: true, focused: false })).toBe(false);
    }
  });
});

describe('NoticeDeduper', () => {
  it('lets a tag through once per window', () => {
    const d = new NoticeDeduper(1000);
    expect(d.first('a', 0)).toBe(true);
    expect(d.first('a', 500)).toBe(false);
    expect(d.first('b', 500)).toBe(true);
    expect(d.first('a', 1000)).toBe(true);
  });
});

describe('secureContextProblem', () => {
  it('is nothing in a secure context, including loopback over http', () => {
    expect(secureContextProblem({ isSecureContext: true, protocol: 'http:', hostname: '127.0.0.1' })).toBeUndefined();
    expect(secureContextProblem({ isSecureContext: true, protocol: 'https:', hostname: 'mac.local' })).toBeUndefined();
  });

  it('says why when the LAN address is plain http', () => {
    const why = secureContextProblem({ isSecureContext: false, protocol: 'http:', hostname: '192.168.1.5' });
    expect(why).toContain('https');
    expect(why).toContain('192.168.1.5');
  });

  it('still says something for an insecure https page', () => {
    expect(secureContextProblem({ isSecureContext: false, protocol: 'https:', hostname: 'x' })).toContain('secure');
  });
});

describe('pickRecorderMime', () => {
  const supports = (...types: string[]) => (t: string) => types.includes(t);

  it('prefers webm/opus where it is there (Chrome, Firefox)', () => {
    expect(pickRecorderMime(supports('audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'))).toBe('audio/webm;codecs=opus');
  });

  it('takes mp4 on iOS Safari, which records nothing else', () => {
    expect(pickRecorderMime(supports('audio/mp4'))).toBe('audio/mp4');
  });

  it('falls through to plain webm, then ogg', () => {
    expect(pickRecorderMime(supports('audio/webm'))).toBe('audio/webm');
    expect(pickRecorderMime(supports('audio/ogg;codecs=opus'))).toBe('audio/ogg;codecs=opus');
  });

  it('is undefined when nothing is supported, and survives a browser that throws', () => {
    expect(pickRecorderMime(() => false)).toBeUndefined();
    expect(
      pickRecorderMime((t) => {
        if (t === 'audio/webm;codecs=opus') throw new Error('nope');
        return t === 'audio/mp4';
      }),
    ).toBe('audio/mp4');
  });
});

describe('audioExtension', () => {
  it('maps the containers browsers record, ignoring parameters and case', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('Audio/MP4')).toBe('m4a');
    expect(audioExtension('audio/ogg; codecs=opus')).toBe('ogg');
  });

  it('refuses everything else', () => {
    expect(audioExtension(undefined)).toBeUndefined();
    expect(audioExtension('text/html')).toBeUndefined();
    expect(audioExtension('video/webm')).toBeUndefined();
  });
});

// ---- transcribing an upload, against fake processes ----

class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = null;
  kill = () => true;
}

function pcmWav(ms: number): Buffer {
  const pcm = Buffer.alloc(Math.round((ms * SAMPLE_RATE) / 1000) * 2, 1);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  return Buffer.concat([header, pcm]);
}

function uploadRig(opts: { ffmpegExit?: number; wavMs?: number; whisperOut?: string } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-upload-test-'));
  const calls: { cmd: string; args: string[] }[] = [];
  const svc = new DictationService({
    spawn: ((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const p = new FakeProc();
      if (cmd === '/f') {
        // ffmpeg: the input exists, and the output is what it was asked to write.
        const out = args[args.length - 1]!;
        if ((opts.ffmpegExit ?? 0) === 0) fs.writeFileSync(out, pcmWav(opts.wavMs ?? 1000));
        else setTimeout(() => p.stderr.emit('data', Buffer.from('Invalid data found\n')), 0);
        setTimeout(() => p.emit('close', opts.ffmpegExit ?? 0, null), 1);
      } else {
        setTimeout(() => {
          p.stdout.emit('data', Buffer.from(opts.whisperOut ?? ' Run the tests.\n'));
          p.emit('close', 0, null);
        }, 0);
      }
      return p;
    }) as unknown as DictationDeps['spawn'],
    settings: () => ({ ffmpegPath: '/f', whisperPath: '/w', modelPath: __filename }),
    tmpDir: tmp,
  });
  return { svc, calls, tmp };
}

describe('DictationService.transcribeAudio', () => {
  it('converts the upload to 16 kHz mono wav with ffmpeg, then runs whisper on it', async () => {
    const { svc, calls, tmp } = uploadRig();
    try {
      expect(await svc.transcribeAudio(Buffer.from('audio'), 'webm')).toBe('Run the tests.');
      expect(calls.map((c) => c.cmd)).toEqual(['/f', '/w']);
      const ffArgs = calls[0]!.args;
      expect(ffArgs).toEqual(convertArgs(ffArgs[ffArgs.indexOf('-i') + 1]!, ffArgs[ffArgs.length - 1]!));
      expect(ffArgs[ffArgs.indexOf('-i') + 1]).toMatch(/\.webm$/);
      expect(ffArgs).toContain('16000');
      expect(ffArgs).toContain('-t');
      await new Promise((r) => setTimeout(r, 20));
      expect(fs.readdirSync(tmp)).toEqual([]); // both temp files removed
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('is empty for a click-length recording or whisper noise, without running whisper on the first', async () => {
    const short = uploadRig({ wavMs: 100 });
    const quiet = uploadRig({ whisperOut: '[BLANK_AUDIO]\n' });
    try {
      expect(await short.svc.transcribeAudio(Buffer.from('a'), 'm4a')).toBe('');
      expect(short.calls.map((c) => c.cmd)).toEqual(['/f']);
      expect(await quiet.svc.transcribeAudio(Buffer.from('a'), 'm4a')).toBe('');
    } finally {
      fs.rmSync(short.tmp, { recursive: true, force: true });
      fs.rmSync(quiet.tmp, { recursive: true, force: true });
    }
  });

  it('fails with ffmpeg\'s reason when it cannot read the audio', async () => {
    const { svc, tmp } = uploadRig({ ffmpegExit: 1 });
    try {
      await expect(svc.transcribeAudio(Buffer.from('junk'), 'webm')).rejects.toThrow(/could not read the recording.*Invalid data/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws the setup error when a tool is missing', async () => {
    // `resolveTools` trusts an explicit tool path, so the missing piece is the model here.
    const noModel = new DictationService({
      spawn: (() => {
        throw new Error('must not spawn');
      }) as unknown as DictationDeps['spawn'],
      settings: () => ({ ffmpegPath: '/f', whisperPath: '/w', modelPath: '/nonexistent/model.bin' }),
    });
    await expect(noModel.transcribeAudio(Buffer.from('a'), 'webm')).rejects.toBeInstanceOf(DictationSetupError);
  });
});
