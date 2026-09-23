/**
 * A `RemoteAsk` as a Discord message.
 *
 * The only file that knows what an embed is. Pure, so the whole rendering —
 * including every length limit Discord enforces and would otherwise reject the
 * message for — is testable without a network.
 *
 * The shape is chosen for the case the feature exists for: a phone notification
 * seen from across a room. The title says who wants what, because that is the
 * preview line; the command is a code block, because it is the thing being
 * agreed to; everything else is a field.
 */
import type { RemoteAsk, RemoteNotice } from '../../shared/remote';
import type { RemoteClose } from '../transport';
import { encodeCustomId } from './ids';

/** Discord's documented ceilings. Exceeding one is a 400, not a truncation. */
const LIMIT = {
  title: 256,
  description: 4096,
  fieldName: 256,
  fieldValue: 1024,
  buttonLabel: 80,
  footer: 2048,
  /** Sum of title + description + fields + footer across all embeds. */
  total: 6000,
} as const;

const COLOUR = {
  warn: 0xe0a33e,
  info: 0x5865f2,
  pending: 0xe0a33e,
  allowed: 0x3ba55d,
  denied: 0xed4245,
  closed: 0x8a8a8a,
} as const;

/** Button styles: 1 primary, 2 secondary, 3 success, 4 danger. */
const STYLE = { primary: 3, secondary: 2, danger: 4 } as const;

export interface DiscordMessagePayload {
  embeds: unknown[];
  components: unknown[];
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A field, or nothing when there is no value — an empty field is a 400. */
function field(name: string, value: string | undefined, inline = true): unknown | undefined {
  if (!value) return undefined;
  return { name: clip(name, LIMIT.fieldName), value: clip(value, LIMIT.fieldValue), inline };
}

/**
 * Fence a command for display.
 *
 * Backticks inside the body would end the fence early and let the rest render
 * as markdown — at best ugly, at worst hiding part of what is being approved.
 * A zero-width space after each backtick defeats that without changing what the
 * characters are.
 */
function codeBlock(body: string, language = 'sh'): string {
  return `\`\`\`${language}\n${body.replace(/`/g, '`​')}\n\`\`\``;
}

/** What the card calls itself, per kind. */
const HEADLINE: Record<RemoteAsk['kind'], string> = {
  permission: 'Agent Wrangler — permission required',
  question: 'Agent Wrangler — a question for you',
  plan: 'Agent Wrangler — plan approval',
};

/**
 * The body of the card, which is the one part that is genuinely different per
 * kind: a command to run, a question with its options, or a plan to read.
 *
 * A plan is markdown and stays markdown — it is prose meant to be read, and a
 * code block would make a wall of monospace out of it. A command stays in a
 * code block for the opposite reason: it is a literal string whose every
 * character matters.
 */
function bodyFor(ask: RemoteAsk): string[] {
  const parts: string[] = [];
  switch (ask.kind) {
    case 'permission':
      if (ask.subject?.body) {
        parts.push('**Requested action**');
        parts.push(codeBlock(ask.subject.body, ask.subject.isCommand ? 'sh' : ''));
      }
      if (ask.subject?.summary) {
        parts.push('**Reason**');
        parts.push(ask.subject.summary);
      }
      return parts;
    case 'question':
      parts.push(`**${ask.header ?? 'Question'}**`);
      parts.push(ask.question);
      if (ask.options.length > 0) {
        parts.push('');
        // Listed even when they are buttons: a button label is clipped at 80
        // and carries no description, and the description is often the part
        // that decides it.
        for (const o of ask.options) {
          parts.push(o.description ? `• **${o.label}** — ${o.description}` : `• **${o.label}**`);
        }
      }
      return parts;
    case 'plan':
      parts.push(ask.plan);
      // The one number on this card that changes what a press means.
      if (ask.more) parts.push(`\n*…and ${ask.more.toLocaleString()} more characters not shown here.*`);
      return parts;
  }
}

/**
 * The card as posted, with its buttons.
 *
 * Every choice the ask offers becomes a button, in the ask's own order. The
 * labels are the ask's — this file decides nothing about which options exist,
 * only how they look.
 */
export function askPayload(interactionId: string, ask: RemoteAsk): DiscordMessagePayload {
  const fields = [
    field('Agent', ask.context.agent),
    field('Repository', ask.context.repository),
    field('Branch', ask.context.branch),
    field('Worktree', ask.context.worktree),
    field('Tool', ask.toolName),
    field('Model', ask.context.model),
  ].filter(Boolean);

  const parts = bodyFor(ask);
  // A choice whose label carries a detail (where an "always" rule is saved)
  // says so in the body: a Discord button has no tooltip to put it in.
  for (const choice of ask.choices) {
    if (choice.detail) parts.push(`*${choice.label}: ${choice.detail}*`);
  }
  // What this card cannot do, when it cannot do everything the local one can.
  if (ask.note) parts.push(`*${ask.note}*`);

  const embed = {
    title: clip(HEADLINE[ask.kind], LIMIT.title),
    description: clip(parts.join('\n'), LIMIT.description),
    color: COLOUR.pending,
    fields,
    footer: { text: clip(ask.title, LIMIT.footer) },
  };

  return {
    embeds: [fit(embed)],
    components: buttons(interactionId, ask),
  };
}

/**
 * The same message once it is over, with **no components at all**.
 *
 * Leaving a disabled button would be a lie of a different kind — it says this
 * was a thing you could have done, rather than that it is finished. Removing
 * them is also what makes a press on a stale message impossible rather than
 * merely refused.
 */
export function closedPayload(ask: RemoteAsk, outcome: RemoteClose): DiscordMessagePayload {
  const when = new Date(outcome.atMs).toISOString().slice(11, 19);
  const by = outcome.by ? ` by ${outcome.by.displayName}` : '';

  const headline =
    outcome.outcome === 'allowed'
      ? `✅ ${ask.kind === 'plan' ? 'Approved' : 'Allowed'}${by}`
      : outcome.outcome === 'denied'
        ? `❌ Denied${by}`
        : outcome.outcome === 'answered'
          ? // The answer is the news, so it goes in the headline rather than
            // the body. Falls back to the plain form if the label is missing —
            // a mirror written by an older build has no label to show.
            outcome.label
            ? `✅ ${outcome.by?.displayName ?? 'Answered'}${outcome.by ? ' chose' : ':'} ${outcome.label}`
            : `✅ Answered${by}`
          : outcome.outcome === 'cancelled'
            ? '⃠ No longer being asked'
            : '↩︎ Answered in Agent Wrangler';

  // Deliberately not "allowed" or "denied" when nobody pressed here: the hook
  // path cannot observe which answer was given at the machine, and inventing
  // one would be worse than saying where it happened.
  const detail =
    outcome.outcome === 'answered-locally'
      ? 'This was answered at the machine, so which way is not recorded here.'
      : outcome.outcome === 'cancelled'
        ? 'The session ended, or remote control was switched off.'
        : outcome.choiceId === 'always'
          ? 'Allowed, and the rule was saved so it stops asking.'
          : '';

  const embed = {
    title: clip(headline, LIMIT.title),
    description: clip([detail, `Resolved at ${when}`].filter(Boolean).join('\n'), LIMIT.description),
    color:
      outcome.outcome === 'allowed' || outcome.outcome === 'answered'
        ? COLOUR.allowed
        : outcome.outcome === 'denied'
          ? COLOUR.denied
          : COLOUR.closed,
    fields: [field('Agent', ask.context.agent), field('Tool', ask.toolName)].filter(Boolean),
    footer: { text: clip(ask.title || 'Agent Wrangler', LIMIT.footer) },
  };

  return { embeds: [fit(embed)], components: [] };
}

/**
 * An announcement: an embed and nothing else.
 *
 * No components, because there is nothing to press, and no mentions are parsed
 * — a notice must never be able to ping a channel because of a character that
 * happened to be in its text.
 */
export function noticePayload(notice: RemoteNotice): DiscordMessagePayload & { allowed_mentions: unknown } {
  const embed = {
    title: clip(notice.title, LIMIT.title),
    description: clip(notice.body ?? '', LIMIT.description),
    color: notice.tone === 'info' ? COLOUR.info : COLOUR.warn,
    fields: [] as unknown[],
    footer: { text: 'Agent Wrangler' },
  };
  return { embeds: [fit(embed)], components: [], allowed_mentions: { parse: [] } };
}

/** One action row. Five buttons is Discord's limit and three is our maximum. */
function buttons(interactionId: string, ask: RemoteAsk): unknown[] {
  if (ask.choices.length === 0) return [];
  return [
    {
      type: 1,
      components: ask.choices.slice(0, 5).map((choice) => ({
        type: 2,
        style: STYLE[choice.tone ?? 'secondary'],
        label: clip(choice.label, LIMIT.buttonLabel),
        custom_id: encodeCustomId(interactionId, choice.action),
      })),
    },
  ];
}

/**
 * Bring an embed under Discord's 6000-character total.
 *
 * Only reachable with a very long command, since `permissionDetail` caps the
 * body at 2000 and the service at 1200 before it gets here. The description is
 * what gives, because the fields are the identifying facts and losing those
 * would make the card ambiguous about *which* agent is asking.
 */
function fit(embed: {
  title: string;
  description: string;
  color: number;
  fields: unknown[];
  footer: { text: string };
}): unknown {
  const fieldChars = (embed.fields as { name: string; value: string }[]).reduce(
    (n, f) => n + f.name.length + f.value.length,
    0,
  );
  const measured = embed.title.length + embed.footer.text.length + fieldChars;
  const room = LIMIT.total - measured;
  if (embed.description.length <= room) return embed;
  return { ...embed, description: clip(embed.description, Math.max(0, room)) };
}
