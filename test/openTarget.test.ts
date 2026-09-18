import { describe, expect, it } from 'vitest';
import type { AgentSession, SessionStatus } from '../src/shared/model';
import { adoptActionFor, openTargetFor } from '../src/ui/openTarget';

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
  it('always stays in the conversation pane', () => expect(openTargetFor()).toBe('conversation'));
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

it('offers a deliberate takeover for estimated busy status', () => {
  expect(adoptActionFor(session({ status: 'busy', statusIsEstimated: true }), false)).toBe('adopt');
});
