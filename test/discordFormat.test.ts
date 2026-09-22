import { describe, expect, it } from 'vitest';
import { askPayload, closedPayload } from '../src/remote/discord/format';
import type { RemoteAsk } from '../src/shared/remote';
import type { RemoteClose } from '../src/remote/transport';

const INTERACTION = 'AbCd1234_-efGhIjKlMn';

function ask(extra: Partial<RemoteAsk> = {}): RemoteAsk {
  return {
    askKey: 'claude:sess-a#100-1',
    sessionKey: 'claude:sess-a',
    requestId: '100-1',
    kind: 'permission',
    title: 'agent-a needs permission for Bash',
    toolName: 'Bash',
    subject: { summary: 'Publish the branch', body: 'git push origin feature/example', isCommand: true },
    context: { agent: 'agent-a', repository: 'proj', branch: 'feature/example' },
    choices: [
      { action: 'allow', label: 'Allow once', tone: 'primary' },
      { action: 'deny', label: 'Deny', tone: 'danger' },
    ],
    ...extra,
  };
}

/** Everything Discord counts toward the 6000-character embed ceiling. */
function embedChars(payload: { embeds: unknown[] }): number {
  const e = payload.embeds[0] as {
    title: string;
    description: string;
    fields: { name: string; value: string }[];
    footer: { text: string };
  };
  return (
    e.title.length +
    e.description.length +
    e.footer.text.length +
    e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

describe('askPayload', () => {
  it('renders one button per choice, in the ask’s order', () => {
    const payload = askPayload(INTERACTION, ask());
    const row = payload.components[0] as { type: number; components: { label: string; custom_id: string }[] };
    expect(row.type).toBe(1);
    expect(row.components.map((c) => c.label)).toEqual(['Allow once', 'Deny']);
    expect(row.components.map((c) => c.custom_id)).toEqual([`aw:${INTERACTION}:allow`, `aw:${INTERACTION}:deny`]);
  });

  it('renders three buttons when the ask offers an always', () => {
    const payload = askPayload(
      INTERACTION,
      ask({
        choices: [
          { action: 'allow', label: 'Allow once', tone: 'primary' },
          { action: 'always', label: 'Always allow Bash(git push:*)', detail: 'Saved to your user settings.' },
          { action: 'deny', label: 'Deny', tone: 'danger' },
        ],
      }),
    );
    const row = payload.components[0] as { components: { label: string }[] };
    expect(row.components).toHaveLength(3);
    // A Discord button has no tooltip, so where the rule is saved goes in the body.
    expect((payload.embeds[0] as { description: string }).description).toContain('Saved to your user settings.');
  });

  it('puts the command in a code block', () => {
    const description = (askPayload(INTERACTION, ask()).embeds[0] as { description: string }).description;
    expect(description).toContain('```sh\ngit push origin feature/example\n```');
    expect(description).toContain('Publish the branch');
  });

  it('neutralises backticks so a command cannot break out of its fence', () => {
    // Otherwise the rest of the card renders as markdown, hiding part of what
    // is being approved.
    const payload = askPayload(INTERACTION, ask({ subject: { body: 'echo ```evil', isCommand: true } }));
    const description = (payload.embeds[0] as { description: string }).description;
    const fences = description.split('```').length - 1;
    expect(fences).toBe(2); // exactly the opening and closing fence
  });

  it('identifies the agent, repository and branch as fields', () => {
    const fields = (askPayload(INTERACTION, ask()).embeds[0] as { fields: { name: string; value: string }[] }).fields;
    expect(fields.map((f) => f.name)).toEqual(['Agent', 'Repository', 'Branch', 'Tool']);
    expect(fields.find((f) => f.name === 'Branch')?.value).toBe('feature/example');
  });

  it('omits fields it has no value for, rather than sending empty ones', () => {
    // Discord rejects an empty field value with a 400.
    const payload = askPayload(INTERACTION, ask({ context: { agent: 'agent-a' } }));
    const fields = (payload.embeds[0] as { fields: { name: string }[] }).fields;
    expect(fields.map((f) => f.name)).toEqual(['Agent', 'Tool']);
  });

  it('includes the worktree when there is one', () => {
    const payload = askPayload(INTERACTION, ask({ context: { agent: 'a', worktree: 'proj-feature' } }));
    const fields = (payload.embeds[0] as { fields: { name: string; value: string }[] }).fields;
    expect(fields.find((f) => f.name === 'Worktree')?.value).toBe('proj-feature');
  });

  it('survives an ask with no subject at all', () => {
    const payload = askPayload(INTERACTION, ask({ subject: undefined }));
    expect((payload.embeds[0] as { description: string }).description).toBe('');
    expect(payload.components).toHaveLength(1);
  });

  it('puts the one-line title in the footer, where a notification shows it', () => {
    const footer = (askPayload(INTERACTION, ask()).embeds[0] as { footer: { text: string } }).footer;
    expect(footer.text).toBe('agent-a needs permission for Bash');
  });

  describe('Discord’s limits', () => {
    it('keeps a button label inside 80 characters', () => {
      const payload = askPayload(
        INTERACTION,
        ask({ choices: [{ action: 'always', label: `Always allow ${'x'.repeat(200)}` }] }),
      );
      const row = payload.components[0] as { components: { label: string }[] };
      expect(row.components[0].label.length).toBeLessThanOrEqual(80);
      expect(row.components[0].label.endsWith('…')).toBe(true);
    });

    it('keeps the whole embed inside 6000 characters', () => {
      const payload = askPayload(INTERACTION, ask({ subject: { body: 'x'.repeat(20000), isCommand: true } }));
      expect(embedChars(payload)).toBeLessThanOrEqual(6000);
    });

    it('keeps a field value inside 1024 characters', () => {
      const payload = askPayload(INTERACTION, ask({ context: { agent: 'a'.repeat(5000) } }));
      const fields = (payload.embeds[0] as { fields: { value: string }[] }).fields;
      expect(fields[0].value.length).toBeLessThanOrEqual(1024);
    });

    it('never sends more than five buttons in a row', () => {
      const many = Array.from({ length: 9 }, (_, i) => ({ action: 'allow' as const, label: `choice ${i}` }));
      const row = askPayload(INTERACTION, ask({ choices: many })).components[0] as { components: unknown[] };
      expect(row.components).toHaveLength(5);
    });
  });
});

describe('closedPayload', () => {
  const at = Date.UTC(2026, 8, 21, 14, 32, 7);

  it('removes every component, so a stale press is impossible rather than refused', () => {
    for (const outcome of ['allowed', 'denied', 'answered-locally', 'cancelled'] as const) {
      const payload = closedPayload(ask(), { outcome, atMs: at });
      expect(payload.components).toEqual([]);
    }
  });

  it('names who allowed it', () => {
    const outcome: RemoteClose = { outcome: 'allowed', by: { id: 'U1', displayName: 'James' }, choiceId: 'allow', atMs: at };
    const embed = closedPayload(ask(), outcome).embeds[0] as { title: string; description: string };
    expect(embed.title).toBe('✅ Allowed by James');
    expect(embed.description).toContain('14:32:07');
  });

  it('names who denied it', () => {
    const outcome: RemoteClose = { outcome: 'denied', by: { id: 'U1', displayName: 'James' }, choiceId: 'deny', atMs: at };
    expect((closedPayload(ask(), outcome).embeds[0] as { title: string }).title).toBe('❌ Denied by James');
  });

  it('says an always allow saved a rule', () => {
    const outcome: RemoteClose = { outcome: 'allowed', by: { id: 'U1', displayName: 'J' }, choiceId: 'always', atMs: at };
    expect((closedPayload(ask(), outcome).embeds[0] as { description: string }).description).toContain('stops asking');
  });

  it('does not guess which way a local answer went', () => {
    // There is no PermissionGranted hook, so after the fact Agent Wrangler
    // genuinely cannot tell allow from deny. Saying so beats inventing one.
    const embed = closedPayload(ask(), { outcome: 'answered-locally', atMs: at }) .embeds[0] as {
      title: string;
      description: string;
    };
    expect(embed.title).toBe('↩︎ Answered in Agent Wrangler');
    expect(embed.description).toContain('not recorded here');
    expect(embed.title).not.toMatch(/Allowed|Denied/);
  });

  it('explains a cancellation', () => {
    const embed = closedPayload(ask(), { outcome: 'cancelled', atMs: at }).embeds[0] as { description: string };
    expect(embed.description).toContain('switched off');
  });

  it('still renders when the ask is only a placeholder', () => {
    // A close is built from the mirror record, which has no title or tool.
    const placeholder = ask({ title: '', toolName: '', context: { agent: '' }, subject: undefined, choices: [] });
    const payload = closedPayload(placeholder, { outcome: 'answered-locally', atMs: at });
    expect(payload.components).toEqual([]);
    expect((payload.embeds[0] as { footer: { text: string } }).footer.text).toBe('Agent Wrangler');
  });

  it('does not repeat the command on the way out', () => {
    const embed = closedPayload(ask(), { outcome: 'allowed', atMs: at }).embeds[0] as { description: string };
    expect(embed.description).not.toContain('git push');
  });
});
