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
  | { kind: 'projects'; json: boolean }
  /**
   * `delegate` (#82) is the handoff: the planner decides one task or several.
   * `task` is the explicit single-task shortcut (#80). For both: `objective`
   * undefined: read it from stdin (`aw delegate -`). `folder` undefined: the
   * current directory. `harness` undefined: let the resolver choose.
   */
  | { kind: 'delegate' | 'task'; objective: string | undefined; criteria: string[]; folder: string | undefined; harness: 'claude' | 'codex' | undefined; json: boolean }
  | { kind: 'tasks'; json: boolean }
  /** `open`: sign this Mac's default browser in. `url`: print the single-use link instead (#127). */
  | { kind: 'web'; action: 'open' | 'url' }
  /** Start pairing a device on the home network: a QR code and a code, for five minutes (#137). */
  | { kind: 'webPair' }
  /** The browser devices, or revoke one (`id`: an id or a unique prefix) (#137). */
  | { kind: 'webDevices'; json: boolean }
  | { kind: 'webRevoke'; id: string }
  /**
   * The core daemon (#130). `start` installs or starts it; `stop` signals it
   * (`all`: hosted conversations end too, as ⌥⌘Q); `status` reads its manifest
   * and probes its socket. None of them need the control socket to answer.
   */
  | { kind: 'daemon'; action: 'start' | 'stop' | 'status'; all: boolean; json: boolean };

export const USAGE = `aw — Agent Wrangler from a terminal

Usage:
  aw status                 what Agent Wrangler is doing (works with the app quit)
  aw sessions [--all]       the sessions in the table (--all: archived too; works with the app quit)
  aw session <id>           one session in detail
  aw attach <id>            follow a session Agent Wrangler runs, read-only (Ctrl-C to stop)
  aw send <id> <text…>      send a message to a session Agent Wrangler runs ("-" reads stdin)
  aw stop <id> [--force]    end the process running a session (--force: even mid-turn)
  aw projects               the project folders the launcher offers
  aw delegate <objective…>  hand work to Agent Wrangler: a read-only planner decides whether
                            it is one task or several, and it waits for you to approve the
                            proposal or the plan in the app ("-" reads the objective from stdin)
      --criteria "a; b"     acceptance criteria, separated by semicolons
      --folder <dir>        the repository (default: the current directory)
      --claude | --codex    which agent to prefer (default: let routing choose)
  aw task <objective…>      shortcut: always one task, no planner (same options as delegate)
  aw tasks                  tasks that are not finished
  aw web open               open the workbench in your default browser, signed in
  aw web url                print a single-use sign-in link instead (good once, for 2 minutes)
  aw web pair               pair a phone or tablet on your home network: shows a QR code to
                            scan and a code to type (good once, for 5 minutes)
  aw web devices            the browsers that can sign in, on this Mac and paired
  aw web devices revoke <id>  sign one out for good; its open tabs disconnect at once
  aw daemon start           run the core as a background service (experimental.coreDaemon)
  aw daemon stop [--all]    stop it; conversations in session hosts keep running
                            (--all: end them too, like Quit and Stop All Agents)
  aw daemon status          whether it is running: pid, build, uptime

<id> is a session id, a unique prefix of one (4+ characters), or a key like claude:<id>.
--json prints the raw result for status, sessions, session, projects, delegate, task, tasks and web devices.
`;

export function parseArgs(argv: readonly string[]): Command | { error: string } {
  // First, because everything after the id is the message, `--help` included.
  if (argv[0] === 'send') return parseSend(argv.slice(1));
  // First too: its options take values, and the objective is free text.
  if (argv[0] === 'task' || argv[0] === 'delegate') return parseHandoff(argv[0], argv.slice(1));
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
  const checked = ['status', 'sessions', 'ls', 'session', 'show', 'attach', 'stop', 'projects', 'tasks'];
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
    case 'tasks':
      return allowed('--json') ?? { kind: 'tasks', json };
    case 'web': {
      const [action, ...more] = rest;
      if (action === 'devices') {
        const [sub, id, ...extra] = more;
        if (sub === undefined) return allowed('--json') ?? { kind: 'webDevices', json };
        if (sub !== 'revoke') return { error: `aw web devices: unexpected "${sub}" (aw web devices, aw web devices revoke <id>)` };
        const bad = allowed();
        if (bad) return bad;
        if (!id) return { error: 'aw web devices revoke: which device? Give its id (aw web devices lists them).' };
        if (extra.length > 0) return { error: `aw web devices revoke: unexpected "${extra[0]}"` };
        return { kind: 'webRevoke', id };
      }
      const bad = allowed();
      if (bad) return bad;
      if (action !== 'open' && action !== 'url' && action !== 'pair') {
        return { error: 'aw web: open, url, pair or devices? (aw web open, aw web url, aw web pair, aw web devices)' };
      }
      if (more.length > 0) return { error: `aw web ${action}: unexpected "${more[0]}"` };
      return action === 'pair' ? { kind: 'webPair' } : { kind: 'web', action };
    }
    case 'daemon': {
      const [action, ...more] = rest;
      if (action !== 'start' && action !== 'stop' && action !== 'status') {
        return { error: 'aw daemon: start, stop or status? (aw daemon start, aw daemon stop [--all], aw daemon status)' };
      }
      const bad = action === 'stop' ? allowed('--all') : action === 'status' ? allowed('--json') : allowed();
      if (bad) return bad;
      if (more.length > 0) return { error: `aw daemon ${action}: unexpected "${more[0]}"` };
      return { kind: 'daemon', action, all: flags.has('--all'), json };
    }
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
 * `aw delegate|task <objective…> [--criteria "a; b"] [--folder <dir>] [--claude|--codex] [--json]`.
 * Options may come anywhere; every other word is the objective. `--` ends the
 * options, so an objective may itself contain `--criteria`.
 */
function parseHandoff(kind: 'delegate' | 'task', tail: readonly string[]): Command | { error: string } {
  const words: string[] = [];
  let criteria: string[] = [];
  let folder: string | undefined;
  let harness: 'claude' | 'codex' | undefined;
  let json = false;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === '--') {
      words.push(...tail.slice(i + 1));
      break;
    }
    if (a === '--criteria' || a === '--folder') {
      const value = tail[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `aw ${kind}: ${a} needs a value.` };
      i++;
      if (a === '--criteria') criteria = [...criteria, ...value.split(';').map((c) => c.trim()).filter(Boolean)];
      else folder = value;
      continue;
    }
    if (a === '--claude' || a === '--codex') {
      const wanted = a === '--claude' ? 'claude' : 'codex';
      if (harness && harness !== wanted) return { error: `aw ${kind}: give --claude or --codex, not both.` };
      harness = wanted;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--help' || a === '-h') return { kind: 'help' };
    if (a.startsWith('--')) return { error: `aw ${kind}: unknown option ${a}` };
    words.push(a);
  }
  if (words.length === 0) {
    return { error: `aw ${kind}: what should ${kind === 'task' ? 'the task do' : 'be done'}? Give the objective, or "-" to read it from stdin.` };
  }
  const base = { criteria, folder, harness, json } as const;
  if (words.length === 1 && words[0] === '-') return { kind, objective: undefined, ...base };
  const objective = words.join(' ');
  if (objective.trim().length === 0) return { error: `aw ${kind}: the objective is empty.` };
  return { kind, objective, ...base };
}

/**
 * Why `aw web pair` or `aw web devices revoke` will not run in this shell, or
 * undefined (#137). `inside` is `agentEnvironment(process.env)`. The same
 * speed bump as `send`, `stop` and `web url`: a pairing code is the whole
 * workbench for whoever reads it, and revoking signs a device of yours out.
 */
export function webRefusal(cmd: Command, inside: string | undefined): string | undefined {
  if (!inside) return undefined;
  if (cmd.kind === 'webPair') {
    return `aw web pair: refused, because this shell looks like ${inside}. Pairing lets a device in as you; run it from your own terminal.`;
  }
  if (cmd.kind === 'webRevoke') {
    return `aw web devices revoke: refused, because this shell looks like ${inside}. Run it from your own terminal, or use Preferences → Browser.`;
  }
  return undefined;
}

/** The agent a shell belongs to, for `aw delegate`'s and `aw task`'s default harness preference. */
export function harnessOf(env: Record<string, string | undefined>): 'claude' | 'codex' | undefined {
  if (env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED || env.CODEX_THREAD_ID) return 'codex';
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude';
  return undefined;
}

/** The conversation this shell belongs to, from its agent's environment (#81), for the card `aw delegate` or `aw task` leaves there. */
export function originOf(env: Record<string, string | undefined>): { provider: 'claude' | 'codex'; sessionId: string } | undefined {
  if (env.CODEX_THREAD_ID) return { provider: 'codex', sessionId: env.CODEX_THREAD_ID };
  if (env.CLAUDE_CODE_SESSION_ID) return { provider: 'claude', sessionId: env.CLAUDE_CODE_SESSION_ID };
  return undefined;
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
