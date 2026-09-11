import { describe, expect, it } from 'vitest';
import type { AgentSession, SessionStatus } from '../src/shared/model';
import { adoptActionFor, openTargetFor, secondaryActionFor } from '../src/ui/openTarget';

function session(over: Partial<AgentSession> & { status?: SessionStatus } = {}): AgentSession {
  return {
    provider: 'claude',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    key: 'claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 't',
    status: 'busy',
    lastActivityAt: 0,
    cwd: '/Users/test/proj',
    entrypoint: 'claude-vscode',
    pid: 123,
    ...over,
  };
}

describe('openTargetFor', () => {
  it('opens the conversation pane for every session, wherever it runs', () => {
    // The whole point of the pane: a click never moves the user between
    // windows, so where the process lives stops deciding what a click does.
    for (const location of ['panel', 'terminal', 'other-window', 'external', 'dead', 'unavailable'] as const) {
      expect(openTargetFor(session(), location, false)).toBe('conversation');
      expect(openTargetFor(session(), location, true)).toBe('conversation');
    }
    expect(openTargetFor(session({ status: 'ended', pid: undefined }), 'dead', true)).toBe('conversation');
    expect(openTargetFor(session({ provider: 'codex' }), 'panel', true)).toBe('conversation');
  });

  describe('the old routing, kept behind the setting', () => {
    const legacy = 'wherever-it-runs' as const;

    it('reveals a panel session running in this window', () => {
      expect(openTargetFor(session(), 'panel', false, legacy)).toBe('panel');
    });

    it('shows the terminal for a session running in one of this window’s terminals', () => {
      expect(openTargetFor(session({ entrypoint: 'cli' }), 'terminal', true, legacy)).toBe('terminal');
    });

    it('hands off to the owning window for any live session elsewhere in this VSCode', () => {
      expect(openTargetFor(session({ entrypoint: 'cli' }), 'other-window', true, legacy)).toBe('window');
      expect(openTargetFor(session({ cwd: undefined }), 'other-window', false, legacy)).toBe('conversation');
    });

    it('never opens the panel for a live session it cannot reveal: that would fork it', () => {
      expect(openTargetFor(session(), 'external', true, legacy)).toBe('conversation');
      expect(openTargetFor(session(), 'dead', true, legacy)).toBe('conversation');
    });

    it('falls back to the cwd guess only when the process tree is unavailable', () => {
      expect(openTargetFor(session(), 'unavailable', true, legacy)).toBe('panel');
      expect(openTargetFor(session(), 'unavailable', false, legacy)).toBe('window');
      expect(openTargetFor(session({ entrypoint: 'cli' }), 'unavailable', false, legacy)).toBe('conversation');
    });

    it('resumes ended sessions: into the panel for this project, a terminal otherwise', () => {
      expect(openTargetFor(session({ status: 'ended', pid: undefined }), 'unavailable', true, legacy)).toBe('panel');
      expect(openTargetFor(session({ status: 'ended', pid: undefined }), 'unavailable', false, legacy)).toBe('resume');
    });

    it('knows nothing about other providers', () => {
      expect(openTargetFor(session({ provider: 'codex' }), 'panel', true, legacy)).toBe('conversation');
      expect(openTargetFor(session({ provider: 'codex', status: 'ended' }), 'panel', true, legacy)).toBe('resume');
    });
  });
});

describe('secondaryActionFor', () => {
  it('offers the surface that actually runs the session', () => {
    expect(secondaryActionFor(session(), 'panel', false)).toBe('reveal-panel');
    expect(secondaryActionFor(session(), 'terminal', false)).toBe('show-terminal');
    expect(secondaryActionFor(session(), 'other-window', false)).toBe('focus-window');
  });

  it('offers nothing when nothing in this VSCode can reveal the session', () => {
    expect(secondaryActionFor(session(), 'external', true)).toBeUndefined();
    expect(secondaryActionFor(session(), 'dead', true)).toBeUndefined();
    // Another window can only be focused through its folder.
    expect(secondaryActionFor(session({ cwd: undefined }), 'other-window', false)).toBeUndefined();
  });

  it('falls back to the folder guess with no process tree', () => {
    expect(secondaryActionFor(session(), 'unavailable', true)).toBe('reveal-panel');
    expect(secondaryActionFor(session(), 'unavailable', false)).toBe('focus-window');
    expect(secondaryActionFor(session({ entrypoint: 'cli' }), 'unavailable', false)).toBeUndefined();
  });

  it('resumes an ended session where its project is open, and in a terminal otherwise', () => {
    const ended = session({ status: 'ended', pid: undefined });
    expect(secondaryActionFor(ended, 'dead', true)).toBe('reveal-panel');
    expect(secondaryActionFor(ended, 'dead', false)).toBe('resume-terminal');
  });

  it('knows nothing about other providers', () => {
    expect(secondaryActionFor(session({ provider: 'codex' }), 'panel', true)).toBeUndefined();
    expect(secondaryActionFor(session({ provider: 'codex', status: 'ended' }), 'dead', true)).toBe('resume-terminal');
  });

  it('offers nowhere to go for a session this window already runs', () => {
    expect(secondaryActionFor(session(), 'runner', true)).toBeUndefined();
    expect(openTargetFor(session(), 'runner', true, 'wherever-it-runs')).toBe('conversation');
  });
});

describe('adoptActionFor', () => {
  it('offers to take over an idle session, whoever is running it', () => {
    expect(adoptActionFor(session({ status: 'waiting' }), false)).toBe('adopt');
    expect(adoptActionFor(session({ status: 'done' }), false)).toBe('adopt');
  });

  it('refuses to take over a session mid-turn', () => {
    // Adopting ends the running process, so a turn in flight would be thrown
    // away. The offer simply is not made until it finishes.
    expect(adoptActionFor(session({ status: 'busy' }), false)).toBeUndefined();
    expect(adoptActionFor(session({ status: 'blocked' }), false)).toBeUndefined();
    expect(adoptActionFor(session({ status: 'stuck' }), false)).toBeUndefined();
  });

  it('resumes an ended session rather than adopting it: there is nothing to end', () => {
    expect(adoptActionFor(session({ status: 'ended', pid: undefined }), false)).toBe('resume-here');
  });

  it('offers nothing for a session already running here', () => {
    expect(adoptActionFor(session({ status: 'waiting' }), true)).toBeUndefined();
    expect(adoptActionFor(session({ status: 'ended' }), true)).toBeUndefined();
  });

  it('needs a working directory to resume into', () => {
    expect(adoptActionFor(session({ status: 'waiting', cwd: undefined }), false)).toBeUndefined();
  });

  it('knows nothing about other providers', () => {
    expect(adoptActionFor(session({ provider: 'codex', status: 'waiting' }), false)).toBeUndefined();
  });
});
