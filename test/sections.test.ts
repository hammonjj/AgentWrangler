import { describe, expect, it } from 'vitest';
import { SECTION_LABEL, SECTION_ORDER, sectionOf, type AgentSession } from '../src/shared/model';

function session(over: Partial<AgentSession> = {}): AgentSession {
  return {
    provider: 'claude',
    sessionId: 'sess-1',
    key: 'claude:sess-1',
    title: 'proj',
    status: 'busy',
    lastActivityAt: 1_000,
    ...over,
  };
}

describe('sectionOf', () => {
  it('files an ordinary session under its status', () => {
    expect(sectionOf(session({ status: 'waiting' }))).toBe('waiting');
  });

  /**
   * The reason paused is a section rather than only a chip: a frozen session's
   * status stopped moving the moment it was stopped. Left in Busy it would read
   * as work in progress, and the stuck threshold would relabel it *Possibly
   * stuck* ten minutes later — the worst possible thing to say about a process
   * somebody stopped deliberately.
   */
  it.each(['busy', 'blocked', 'waiting', 'done', 'stuck'] as const)(
    'files a paused %s session under Paused instead',
    (status) => {
      expect(sectionOf(session({ status, paused: true }))).toBe('paused');
    },
  );

  it('lets Archived win over Paused: "out of my way" is the stronger instruction', () => {
    expect(sectionOf(session({ paused: true, archived: true }))).toBe('archived');
  });

  /**
   * A paused agent is a live process you are coming back to, so it belongs
   * above the two sections that hold sessions you are done with rather than
   * among them.
   */
  it('puts Paused above Ended, with Archived last', () => {
    expect(SECTION_ORDER.indexOf('paused')).toBeLessThan(SECTION_ORDER.indexOf('ended'));
    expect(SECTION_ORDER.indexOf('ended')).toBe(SECTION_ORDER.length - 2);
    expect(SECTION_ORDER.indexOf('archived')).toBe(SECTION_ORDER.length - 1);
  });

  it('gives every section a label, so none can render blank', () => {
    for (const id of SECTION_ORDER) expect(SECTION_LABEL[id]).toBeTruthy();
  });
});
