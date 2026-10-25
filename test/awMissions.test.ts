/**
 * `aw missions`, `aw mission` and the grant's three acts (agent mission
 * control, docs/plans/agent-mission-control.md): parsing, the agent-shell
 * refusals (unchanged for everything outside the grant), and what is printed.
 * Fixtures are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { agentEnvironment, agentShellRefusal, parseArgs, type Command } from '../src/cli/args';
import { formatMission, formatMissionAct, formatMissions } from '../src/cli/format';
import { resolveMissionRef, type ControlMissionView } from '../src/core/control/protocol';

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

function view(over: Partial<ControlMissionView> = {}): ControlMissionView {
  return {
    missionId: '01J0000000000000000000000A',
    title: 'Synthetic mission',
    state: 'review',
    phase: 'ready to merge',
    waitingOn: { kind: 'ready-for-review', text: 'accepted, not merged yet — choose merge, pull request, keep or discard' },
    repo: 'proj',
    baseRef: 'main',
    branch: 'aw/synthetic/t1',
    diff: { commits: 2, filesChanged: 3, insertions: 40, deletions: 5 },
    verification: { verdict: 'unverified', noChecks: true },
    tasks: [
      {
        taskId: 't1',
        key: 't1',
        title: 'Do the thing',
        state: 'done',
        phase: 'done',
        attempt: { n: 1, state: 'succeeded' },
        verification: { verdict: 'unverified', summary: 'No checks are configured for this repository, so the result is unverified.', stages: [] },
        branch: 'aw/synthetic/t1',
        diff: { commits: 2, filesChanged: 3, insertions: 40, deletions: 5 },
      },
    ],
    origin: 'yours',
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 60_000,
    ...over,
  };
}

describe('parsing', () => {
  it('aw missions and aw mission <id> are reads', () => {
    expect(parseArgs(['missions'])).toEqual({ kind: 'missions', json: false, all: false, mine: false });
    expect(parseArgs(['missions', '--all', '--mine', '--json'])).toEqual({ kind: 'missions', json: true, all: true, mine: true });
    expect(parseArgs(['missions', '--force'])).toEqual({ error: 'aw missions: unknown option --force' });
    expect(parseArgs(['mission', 'ABCD'])).toEqual({ kind: 'mission', json: false, ref: 'ABCD' });
    expect(parseArgs(['mission'])).toMatchObject({ error: expect.stringContaining('which mission') });
  });

  it('accept, finish and cancel, with a finish choice on accept', () => {
    expect(parseArgs(['mission', 'accept', 'ABCD'])).toEqual({ kind: 'missionAct', act: 'accept', ref: 'ABCD', json: false });
    expect(parseArgs(['mission', 'accept', 'ABCD', '--task', 't2', '--finish', 'pull-request'])).toEqual({
      kind: 'missionAct',
      act: 'accept',
      ref: 'ABCD',
      how: 'pull-request',
      task: 't2',
      json: false,
    });
    expect(parseArgs(['mission', 'finish', 'ABCD', 'merge-local', '--json'])).toEqual({ kind: 'missionAct', act: 'finish', ref: 'ABCD', how: 'merge-local', json: true });
    expect(parseArgs(['mission', 'cancel', 'ABCD'])).toEqual({ kind: 'missionAct', act: 'cancel', ref: 'ABCD', json: false });
  });

  it('refuses a finish it does not know, and options that do not belong', () => {
    expect(parseArgs(['mission', 'finish', 'ABCD'])).toMatchObject({ error: expect.stringContaining('merge-local, pull-request, keep or discard') });
    expect(parseArgs(['mission', 'finish', 'ABCD', 'force-push'])).toMatchObject({ error: expect.stringContaining('how?') });
    expect(parseArgs(['mission', 'accept', 'ABCD', '--finish', 'squash'])).toMatchObject({ error: expect.stringContaining('--finish') });
    expect(parseArgs(['mission', 'cancel', 'ABCD', '--finish', 'keep'])).toMatchObject({ error: expect.stringContaining('go with accept') });
    expect(parseArgs(['mission', 'cancel', 'ABCD', 'now'])).toEqual({ error: 'aw mission cancel: unexpected "now"' });
  });
});

describe('agent-shell refusals: unchanged outside the grant', () => {
  const inside = agentEnvironment({ CLAUDECODE: '1' });
  const cmd = (argv: string[]) => parseArgs(argv) as Command;

  it('send, stop, rename --session, web url, web pair and devices revoke are still refused in an agent shell', () => {
    for (const argv of [['send', 'abcd', 'hi'], ['stop', 'abcd'], ['rename', '--session', 'abcd', 'x'], ['web', 'url'], ['web', 'pair'], ['web', 'devices', 'revoke', 'abcd']]) {
      expect(agentShellRefusal(cmd(argv), inside)).toMatch(/refused, because this shell looks like a Claude Code session/);
    }
    expect(agentShellRefusal(cmd(['send', 'abcd', 'hi']), inside)).toContain('One agent must not drive another through aw');
  });

  it('nothing is refused from your own terminal', () => {
    for (const argv of [['send', 'abcd', 'hi'], ['stop', 'abcd'], ['web', 'url']]) expect(agentShellRefusal(cmd(argv), undefined)).toBeUndefined();
  });

  it('the mission commands are not refused there: reads, and the act runs as the agent under its own grant', () => {
    for (const argv of [['missions'], ['mission', 'ABCD'], ['mission', 'accept', 'ABCD'], ['mission', 'finish', 'ABCD', 'keep'], ['mission', 'cancel', 'ABCD'], ['tasks']]) {
      expect(agentShellRefusal(cmd(argv), inside)).toBeUndefined();
    }
  });
});

describe('mission refs', () => {
  const missions = [{ id: '01J0000000000000000000000A' }, { id: '01J0000000000000000000000B' }];
  it('an id, or a unique prefix or suffix of four characters or more', () => {
    expect(resolveMissionRef(missions, '01j0000000000000000000000a')).toEqual({ match: missions[0] });
    expect(resolveMissionRef(missions, '000B')).toEqual({ match: missions[1] });
    expect(resolveMissionRef(missions, '01J0')).toMatchObject({ error: 'ambiguous' });
    expect(resolveMissionRef(missions, '0B')).toEqual({ error: 'notFound' });
  });
});

describe('what is printed', () => {
  it('missions: id, whose, checks, age, and what each waits on, with who is asking', () => {
    const text = formatMissions({ missions: [view()], caller: { agent: 'Synthetic PO', granted: false } }, NOW, 140);
    expect(text).toContain('mission control is off for you, so you can only read');
    expect(text).toContain('ID');
    expect(text).toContain('yours');
    expect(text).toContain('? unverified');
    expect(text).toContain('accepted, not merged yet');
    expect(formatMissions({ missions: [] }, NOW)).toBe('No missions.');
  });

  it('mission: task states, each check, branch and diff stat against the base', () => {
    const text = formatMission({ mission: view() }, NOW);
    expect(text).toContain('waiting on: accepted, not merged yet');
    expect(text).toContain('[ready-for-review]');
    expect(text).toContain('diff:       3 files +40 −5 (2 commits) vs main');
    expect(text).toContain('checks:     ? unverified (no checks configured)');
    expect(text).toContain('checks: none configured for this repository');
    const checked = view({
      verification: { verdict: 'verified', noChecks: false },
      tasks: [{ ...view().tasks[0], verification: { verdict: 'passed', summary: '1 check passed', stages: [{ strategy: 'command:test', required: true, outcome: 'passed' }] } }],
    });
    expect(formatMission({ mission: checked }, NOW)).toContain('required command:test: passed');
  });

  it('an act: done, requested (a merge waits for the user), refused with its code', () => {
    expect(formatMissionAct({ outcome: 'requested', message: 'Asked the user to confirm the merge.' })).toBe('Requested. Asked the user to confirm the merge.');
    expect(formatMissionAct({ outcome: 'refused', code: 'unverified', message: 'Not verified.', mission: view() })).toContain('Refused (unverified). Not verified.\nNow: review');
    // Terminal escapes in a title an agent wrote never reach the terminal.
    expect(formatMission({ mission: view({ title: 'x\u001b]52;c;AAAA\u0007y' }) }, NOW)).not.toContain('\u001b');
  });
});
