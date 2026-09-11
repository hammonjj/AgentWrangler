import { describe, expect, it } from 'vitest';
import type { AgentSession, SessionStatus } from '../src/shared/model';
import { openTargetFor } from '../src/ui/openTarget';

function session(over: Partial<AgentSession> & { status?: SessionStatus } = {}): AgentSession {
  return {
    provider: 'claude',
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    key: 'claude:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 't',
    status: 'busy',
    lastActivityAt: 0,
    cwd: '/Users/me/proj',
    entrypoint: 'claude-vscode',
    pid: 123,
    ...over,
  };
}

describe('openTargetFor', () => {
  it('reveals a panel session running in this window', () => {
    expect(openTargetFor(session(), 'panel', false)).toBe('panel');
  });

  it('shows the terminal for a session running in one of this window’s terminals', () => {
    expect(openTargetFor(session({ entrypoint: 'cli' }), 'terminal', true)).toBe('terminal');
  });

  it('hands off to the owning window for any live session elsewhere in this VSCode', () => {
    expect(openTargetFor(session({ entrypoint: 'cli' }), 'other-window', true)).toBe('window');
    expect(openTargetFor(session({ cwd: undefined }), 'other-window', false)).toBe('viewer');
  });

  it('never opens the panel for a live session it cannot reveal: that would fork it', () => {
    expect(openTargetFor(session(), 'external', true)).toBe('viewer');
    expect(openTargetFor(session(), 'dead', true)).toBe('viewer');
  });

  it('falls back to the cwd guess only when the process tree is unavailable', () => {
    expect(openTargetFor(session(), 'unavailable', true)).toBe('panel');
    expect(openTargetFor(session(), 'unavailable', false)).toBe('window');
    expect(openTargetFor(session({ entrypoint: 'cli' }), 'unavailable', false)).toBe('viewer');
  });

  it('resumes ended sessions: into the panel for this project, a terminal otherwise', () => {
    expect(openTargetFor(session({ status: 'ended', pid: undefined }), 'unavailable', true)).toBe('panel');
    expect(openTargetFor(session({ status: 'ended', pid: undefined }), 'unavailable', false)).toBe('resume');
  });

  it('knows nothing about other providers', () => {
    expect(openTargetFor(session({ provider: 'codex' }), 'panel', true)).toBe('viewer');
    expect(openTargetFor(session({ provider: 'codex', status: 'ended' }), 'panel', true)).toBe('resume');
  });
});
