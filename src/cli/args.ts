/**
 * `aw`'s command line, parsed. Pure.
 */

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'status'; json: boolean }
  | { kind: 'sessions'; json: boolean; all: boolean }
  | { kind: 'session'; json: boolean; ref: string }
  | { kind: 'attach'; ref: string }
  /** `text` undefined: read it from stdin (`aw send <id> -`). */
  | { kind: 'send'; ref: string; text: string | undefined }
  | { kind: 'stop'; ref: string; force: boolean }
  | { kind: 'projects'; json: boolean };

export const USAGE = `aw — Agent Wrangler from a terminal

Usage:
  aw status                 what Agent Wrangler is doing (works with the app quit)
  aw sessions [--all]       the sessions in the table (--all: archived too; works with the app quit)
  aw session <id>           one session in detail
  aw attach <id>            follow a session Agent Wrangler runs, read-only (Ctrl-C to stop)
  aw send <id> <text…>      send a message to a session Agent Wrangler runs ("-" reads stdin)
  aw stop <id> [--force]    end the process running a session (--force: even mid-turn)
  aw projects               the project folders the launcher offers

<id> is a session id, a unique prefix of one (4+ characters), or a key like claude:<id>.
--json prints the raw result for status, sessions, session and projects.
`;

export function parseArgs(argv: readonly string[]): Command | { error: string } {
  // First, because everything after the id is the message, `--help` included.
  if (argv[0] === 'send') return parseSend(argv.slice(1));
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const words = argv.filter((a) => !a.startsWith('--') || a === '--');
  if (flags.has('--help') || argv.includes('-h')) return { kind: 'help' };
  if (flags.has('--version')) return { kind: 'version' };
  const [name, ...rest] = words.filter((w) => w !== '-h');
  const json = flags.has('--json');
  const allowed = (...ok: string[]) => {
    const bad = [...flags].filter((f) => !ok.includes(f));
    return bad.length > 0 ? { error: `aw ${name}: unknown option ${bad[0]}` } : undefined;
  };
  const takesRef = ['session', 'show', 'attach', 'stop'].includes(name ?? '');
  // `aw stop abcd -f` must not quietly stop without force, nor `aw stop a b` stop only one.
  const extra = rest.find((w, i) => w.startsWith('-') || i >= (takesRef ? 1 : 0));
  const checked = ['status', 'sessions', 'ls', 'session', 'show', 'attach', 'stop', 'projects'];
  if (extra !== undefined && checked.includes(name ?? '')) {
    return { error: extra.startsWith('-') ? `aw ${name}: unknown option ${extra}` : `aw ${name}: unexpected "${extra}"` };
  }
  const needRef = () => (rest[0] ? undefined : { error: `aw ${name}: which session? Give its id.` });

  switch (name) {
    case undefined:
    case 'help':
      return { kind: 'help' };
    case 'version':
      return { kind: 'version' };
    case 'status':
      return allowed('--json') ?? { kind: 'status', json };
    case 'sessions':
    case 'ls':
      return allowed('--json', '--all') ?? { kind: 'sessions', json, all: flags.has('--all') };
    case 'session':
    case 'show':
      return allowed('--json') ?? needRef() ?? { kind: 'session', json, ref: rest[0] };
    case 'attach':
      return allowed() ?? needRef() ?? { kind: 'attach', ref: rest[0] };
    case 'send':
      return { error: 'aw send: put send first: aw send <id> <text…>' };
    case 'stop':
      return allowed('--force') ?? needRef() ?? { kind: 'stop', ref: rest[0], force: flags.has('--force') };
    case 'projects':
      return allowed('--json') ?? { kind: 'projects', json };
    default:
      return { error: `aw: no command "${name}". Run aw help.` };
  }
}

function parseSend(tail: readonly string[]): Command | { error: string } {
  const ref = tail[0];
  if (!ref || ref.startsWith('--')) return { error: 'aw send: which session? Give its id, then the message.' };
  const words = tail.slice(1);
  if (words.length === 0) return { error: 'aw send: what should it say? Give the message, or "-" to read it from stdin.' };
  if (words.length === 1 && words[0] === '-') return { kind: 'send', ref, text: undefined };
  const text = words.join(' ');
  if (text.trim().length === 0) return { error: 'aw send: the message is empty.' };
  return { kind: 'send', ref, text };
}

/**
 * Whether this looks like a shell an agent is running, and which one.
 *
 * `send` and `stop` refuse there. A prompt injected into one agent should not
 * be one `aw send` away from every other session, least of all one with more
 * permissions (playbook §12). This is a speed bump, not a wall: a same-user
 * process can read the token and speak to the socket itself, or scrub its
 * environment, and §12 says plainly that AW cannot stop that. What it stops is
 * the over-eager or injected agent that reaches for the obvious command.
 */
export function agentEnvironment(env: Record<string, string | undefined>): string | undefined {
  if (env.AGENTWRANGLER_HOSTED) return 'a session Agent Wrangler hosts';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'a Claude Code session';
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID) return 'a Codex session';
  return undefined;
}
