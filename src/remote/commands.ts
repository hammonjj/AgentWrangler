/**
 * Remote commands (#59): a small, transport-agnostic registry of things an authorised user can
 * ask Agent Wrangler from a phone. Discord registers them as slash commands; the remote-control
 * web client (#178) can list and run the same ones. Nothing here knows which.
 *
 * A command is data and a handler. Handlers get narrow capabilities (read the usage state,
 * count sessions, flip one setting), never the app. Each reply is private text for the one who
 * asked. Counts and percentages only: no session titles, paths or anything an agent said.
 */
import type { SessionStatus } from '../shared/model';
import { usageErrorText, type UsageState } from '../shared/usage';

export interface RemoteCommand {
  /** Lower-case, `[a-z0-9-]{1,32}`: Discord's rule for a slash command name. */
  name: string;
  /** One line, under 100 characters. */
  description: string;
  /** Changes something (audited as a settings write); otherwise read-only. */
  mutates: boolean;
  run(): Promise<string>;
}

/** What handlers may do. */
export interface CommandCapabilities {
  /** Claude plan usage and, when a Codex provider is active, Codex's. */
  usage(): { claude: UsageState; codex?: UsageState };
  /** Sessions in the table (archived ones excluded), by status. */
  statusCounts(): Partial<Record<SessionStatus, number>>;
  /** Asks waiting on someone: permission prompts, questions, plans. */
  waitingAsks(): { permissions: number; questions: number; plans: number };
  notificationsEnabled(): boolean;
  setNotificationsEnabled(on: boolean): Promise<void>;
  now(): number;
}

export interface CommandRegistry {
  list(): readonly RemoteCommand[];
  get(name: string): RemoteCommand | undefined;
}

export function createCommandRegistry(caps: CommandCapabilities): CommandRegistry {
  const commands: RemoteCommand[] = [
    {
      name: 'status',
      description: 'Whether notifications are on, what is waiting on you, and what is running.',
      mutates: false,
      run: async () => formatStatusReply(caps.notificationsEnabled(), caps.waitingAsks(), caps.statusCounts()),
    },
    {
      name: 'usage',
      description: 'Claude plan usage per window, and Codex when it is active.',
      mutates: false,
      run: async () => formatUsageReply(caps.usage(), caps.now()),
    },
    {
      name: 'enable-notifications',
      description: 'Post prompts and notices to this channel again.',
      mutates: true,
      run: async () => {
        if (caps.notificationsEnabled()) return 'Notifications are already on.';
        await caps.setNotificationsEnabled(true);
        return 'Notifications are on. Anything still waiting is posted again.';
      },
    },
    {
      name: 'disable-notifications',
      description: 'Stop posting; open prompts here are closed. They still wait in Agent Wrangler.',
      mutates: true,
      run: async () => {
        if (!caps.notificationsEnabled()) return 'Notifications are already off.';
        await caps.setNotificationsEnabled(false);
        return 'Notifications are off. Open prompts here are closed; they still wait in Agent Wrangler.';
      },
    },
  ];
  commands.push({
    name: 'help',
    description: 'List these commands.',
    mutates: false,
    run: async () => commands.map((c) => `/${c.name} — ${c.description}`).join('\n'),
  });
  const byName = new Map(commands.map((c) => [c.name, c]));
  return { list: () => commands, get: (name) => byName.get(name) };
}

const STATUS_ORDER: [SessionStatus, string][] = [
  ['blocked', 'waiting on a prompt'],
  ['waiting', 'waiting for input'],
  ['busy', 'working'],
  ['stuck', 'stuck'],
  ['done', 'done'],
];

export function formatStatusReply(
  notificationsOn: boolean,
  asks: { permissions: number; questions: number; plans: number },
  counts: Partial<Record<SessionStatus, number>>,
): string {
  const waiting = asks.permissions + asks.questions + asks.plans;
  const parts = [
    asks.permissions && `${asks.permissions} permission prompt${asks.permissions === 1 ? '' : 's'}`,
    asks.questions && `${asks.questions} question${asks.questions === 1 ? '' : 's'}`,
    asks.plans && `${asks.plans} plan${asks.plans === 1 ? '' : 's'}`,
  ].filter(Boolean);
  const agents = STATUS_ORDER.filter(([s]) => counts[s]).map(([s, label]) => `${counts[s]} ${label}`);
  return [
    `Notifications: ${notificationsOn ? 'on' : 'off'}.`,
    waiting === 0 ? 'Nothing is waiting on you.' : `Waiting on you: ${parts.join(', ')}.`,
    agents.length === 0 ? 'No agents in the table.' : `Agents: ${agents.join(', ')}.`,
  ].join('\n');
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

function resetText(resetsAtMs: number | undefined, now: number): string {
  if (resetsAtMs === undefined) return '';
  const left = resetsAtMs - now;
  return left <= 0 ? ', resetting now' : `, resets in ${ago(left)}`;
}

function providerLines(label: string, state: UsageState, now: number): string[] {
  const snap = state.last;
  if (!snap) return [`${label}: ${state.error ? usageErrorText(state.error) : 'no reading yet.'}`];
  const lines = [`${label} (read ${ago(now - snap.fetchedAtMs)} ago):`];
  for (const w of snap.windows) lines.push(`  ${w.label}: ${Math.round(w.percent)}%${resetText(w.resetsAtMs, now)}`);
  if (snap.spend) lines.push(`  Extra usage: ${Math.round(snap.spend.percent)}% of the monthly limit`);
  if (state.error) lines.push(`  (latest read failed: ${usageErrorText(state.error)})`);
  return lines;
}

export function formatUsageReply(usage: { claude: UsageState; codex?: UsageState }, now: number): string {
  return [...providerLines('Claude', usage.claude, now), ...(usage.codex ? providerLines('Codex', usage.codex, now) : [])].join('\n');
}
