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
  /**
   * Set the session's nickname, or clear it (`name` ''). `ref` undefined: the
   * conversation this shell belongs to (`originOf`).
   */
  | { kind: 'rename'; ref: string | undefined; name: string; json: boolean }
  | { kind: 'projects'; json: boolean }
  /**
   * `delegate` (#82) is the handoff: the planner decides one task or several.
   * `task` is the explicit single-task shortcut (#80). For both: `objective`
   * undefined: read it from stdin (`aw delegate -`). `folder` undefined: the
   * current directory. `harness` undefined: let the resolver choose.
   */
  | { kind: 'delegate' | 'task'; objective: string | undefined; criteria: string[]; folder: string | undefined; harness: 'claude' | 'codex' | undefined; json: boolean }
  | { kind: 'tasks'; json: boolean }
  /**
   * Agent mission control, read-only: missions with their state, task
   * states, checks, branch, diff stat and what each waits on. `all`: finished
   * ones too. `mine`: only the ones this conversation's agent delegated.
   */
  | { kind: 'missions'; json: boolean; all: boolean; mine: boolean }
  | { kind: 'mission'; json: boolean; ref: string }
  /**
   * A durable agent acting on a mission it delegated, under its grant (off by
   * default, set per agent in Preferences). Only from inside the agent's own
   * conversation. `how`: the finish (required for `finish`, optional for
   * `accept`); `merge-local` only ever asks the user.
   */
  | { kind: 'missionAct'; act: 'accept' | 'finish' | 'cancel'; ref: string; how?: 'merge-local' | 'pull-request' | 'keep' | 'discard'; task?: string; json: boolean }
  /**
   * A durable agent proposes a memory update for its user to approve (#180):
   * `remember` adds an item (`text` undefined: read stdin), `forget` removes
   * one by id. Only from inside an agent's conversation, which is the origin.
   */
  | { kind: 'remember'; text: string | undefined; memoryKind: string | undefined; json: boolean }
  | { kind: 'forget'; itemId: string; json: boolean }
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
  aw rename <name…>         name the conversation this shell belongs to, as Rename… does
      --session <id>        another session instead (not from inside an agent's shell)
      --clear               go back to the session's own title
  aw projects               the project folders the launcher offers
  aw delegate <objective…>  hand work to Agent Wrangler: a read-only planner decides whether
                            it is one task or several, and it waits for you to approve the
                            proposal or the plan in the app ("-" reads the objective from stdin)
      --criteria "a; b"     acceptance criteria, separated by semicolons
      --folder <dir>        the repository (default: the current directory)
      --claude | --codex    which agent to prefer (default: let routing choose)
  aw task <objective…>      shortcut: always one task, no planner (same options as delegate)
  aw tasks                  tasks that are not finished
  aw missions [--all] [--mine]  missions, read-only: state, each task's state and checks,
                            branch, diff stat, and what each is waiting on
                            (--all: finished ones too; --mine: only this agent's own)
  aw mission <id>           one mission in detail (id: the full id, or 4+ characters of
                            its start or end)
  aw mission accept <id> [--task <key>] [--finish <how>]
  aw mission finish <id> <how>   how: merge-local, pull-request, keep or discard
  aw mission cancel <id>    from inside a durable agent's conversation, with its mission
                            grant on (Preferences, off by default): act on a mission that
                            agent delegated, once its checks passed. merge-local is never
                            done by an agent: it asks you to confirm in Missions
  aw remember <text…>       from inside a durable agent's conversation: propose a memory note;
                            stored only once the user approves it in the app ("-" reads stdin)
      --kind <kind>         decision (default), preference, question or work
  aw forget <id>            from inside a durable agent's conversation: propose removing a note
  aw web open               open the workbench in your default browser, signed in
  aw web url                print a single-use sign-in link instead (good once, for 2 minutes)
  aw web pair               pair a phone or tablet on your home network: shows a QR code to
                            scan and a code to type (good once, for 5 minutes)
  aw web devices            the browsers that can sign in, on this Mac and paired
  aw web devices revoke <id>  sign one out for good; its open tabs disconnect at once
  aw daemon start           start the background service that runs Agent Wrangler, or move it
                            onto this build (opening the app does the same)
  aw daemon stop [--all]    stop it; conversations in session hosts keep running
                            (--all: end them too)
  aw daemon status          whether it is running: pid, build, uptime

<id> is a session id, a unique prefix of one (4+ characters), or a key like claude:<id>.
--json prints the raw result for status, sessions, session, projects, delegate, task, tasks, missions, mission, rename and web devices.
`;

export function parseArgs(argv: readonly string[]): Command | { error: string } {
  // First, because everything after the id is the message, `--help` included.
  if (argv[0] === 'send') return parseSend(argv.slice(1));
  // First too: its options take values, and the objective is free text.
  if (argv[0] === 'task' || argv[0] === 'delegate') return parseHandoff(argv[0], argv.slice(1));
  if (argv[0] === 'remember') return parseRemember(argv.slice(1));
  if (argv[0] === 'rename') return parseRename(argv.slice(1));
  // Its options take values (`--task t1`, `--finish keep`).
  if (argv[0] === 'mission') return parseMission(argv.slice(1));
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
  const checked = ['status', 'sessions', 'ls', 'session', 'show', 'attach', 'stop', 'projects', 'tasks', 'missions'];
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
    case 'missions':
      return allowed('--json', '--all', '--mine') ?? { kind: 'missions', json, all: flags.has('--all'), mine: flags.has('--mine') };
    case 'forget': {
      const bad = allowed('--json');
      if (bad) return bad;
      if (!rest[0]) return { error: 'aw forget: which note? Give its id, like m-1a2b3c4d.' };
      if (rest.length > 1) return { error: `aw forget: unexpected "${rest[1]}"` };
      return { kind: 'forget', itemId: rest[0], json };
    }
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

/** `aw remember [--kind <kind>] [--json] <text…>`. `--` ends the options. */
function parseRemember(tail: readonly string[]): Command | { error: string } {
  const words: string[] = [];
  let memoryKind: string | undefined;
  let json = false;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === '--') {
      words.push(...tail.slice(i + 1));
      break;
    }
    if (a === '--kind') {
      const value = tail[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: 'aw remember: --kind needs a value: decision, preference, question or work.' };
      memoryKind = value;
      i++;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--help' || a === '-h') return { kind: 'help' };
    if (a.startsWith('--')) return { error: `aw remember: unknown option ${a}` };
    words.push(a);
  }
  if (words.length === 0) return { error: 'aw remember: what should be remembered? Give one short line, or "-" to read it from stdin.' };
  if (words.length === 1 && words[0] === '-') return { kind: 'remember', text: undefined, memoryKind, json };
  const text = words.join(' ');
  if (text.trim().length === 0) return { error: 'aw remember: the note is empty.' };
  return { kind: 'remember', text, memoryKind, json };
}

const FINISHES = ['merge-local', 'pull-request', 'keep', 'discard'] as const;
type FinishArg = (typeof FINISHES)[number];
const isFinish = (v: string | undefined): v is FinishArg => v !== undefined && (FINISHES as readonly string[]).includes(v);

/**
 * `aw mission <id> [--json]`, or one of the grant's three acts:
 * `aw mission accept <id> [--task <key>] [--finish <how>] [--json]`,
 * `aw mission finish <id> <how> [--json]`, `aw mission cancel <id> [--json]`.
 */
function parseMission(tail: readonly string[]): Command | { error: string } {
  const words: string[] = [];
  let json = false;
  let task: string | undefined;
  let finish: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--task' || a === '--finish') {
      const value = tail[i + 1];
      if (value === undefined || value.startsWith('-')) return { error: `aw mission: ${a} needs a value.` };
      if (a === '--task') task = value;
      else finish = value;
      i++;
      continue;
    }
    if (a === '--help' || a === '-h') return { kind: 'help' };
    if (a.startsWith('-')) return { error: `aw mission: unknown option ${a}` };
    words.push(a);
  }
  const [first, ref, third, ...extra] = words;
  if (!first) return { error: 'aw mission: which mission? Give its id (aw missions lists them).' };
  if (first !== 'accept' && first !== 'finish' && first !== 'cancel') {
    if (ref !== undefined) return { error: `aw mission: unexpected "${ref}"` };
    if (task !== undefined || finish !== undefined) return { error: 'aw mission: --task and --finish go with accept.' };
    return { kind: 'mission', json, ref: first };
  }
  const act = first;
  if (!ref) return { error: `aw mission ${act}: which mission? Give its id (aw missions lists them).` };
  if (extra.length > 0) return { error: `aw mission ${act}: unexpected "${extra[0]}"` };
  if (act !== 'accept' && (task !== undefined || finish !== undefined)) return { error: `aw mission ${act}: --task and --finish go with accept.` };
  if (act === 'finish') {
    if (!isFinish(third)) return { error: 'aw mission finish: how? merge-local, pull-request, keep or discard.' };
    return { kind: 'missionAct', act, ref, how: third, json };
  }
  if (third !== undefined) return { error: `aw mission ${act}: unexpected "${third}"` };
  if (finish !== undefined && !isFinish(finish)) return { error: 'aw mission accept: --finish is merge-local, pull-request, keep or discard.' };
  return { kind: 'missionAct', act, ref, ...(finish !== undefined ? { how: finish as FinishArg } : {}), ...(task !== undefined ? { task } : {}), json };
}

/** `aw rename [--session <id>] [--json] <name…>` or `aw rename [--session <id>] --clear`. `--` ends the options. */
function parseRename(tail: readonly string[]): Command | { error: string } {
  const words: string[] = [];
  let ref: string | undefined;
  let clear = false;
  let json = false;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a === '--') {
      words.push(...tail.slice(i + 1));
      break;
    }
    if (a === '--session') {
      const value = tail[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: 'aw rename: --session needs a session id.' };
      ref = value;
      i++;
      continue;
    }
    if (a === '--clear') {
      clear = true;
      continue;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--help' || a === '-h') return { kind: 'help' };
    if (a.startsWith('--')) return { error: `aw rename: unknown option ${a}` };
    words.push(a);
  }
  const name = words.join(' ').trim();
  if (clear && name) return { error: 'aw rename: give a name or --clear, not both.' };
  if (!clear && !name) return { error: 'aw rename: what should it be called? Give a name, or --clear to go back to its own title.' };
  return { kind: 'rename', ref, name, json };
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
 * Why a command will not run in this shell, or undefined (`inside` is
 * `agentEnvironment(process.env)`). The one list of agent-shell refusals:
 * `send` and `stop` (one agent must not drive another), `rename --session`
 * (an agent names only its own conversation), `web url`, and `webRefusal`'s
 * pairing and revoking. Agent mission control adds nothing here and removes
 * nothing: `aw missions` and `aw mission` only read, and `aw mission
 * accept|finish|cancel` acts as the agent, under its own grant, never as you.
 */
export function agentShellRefusal(cmd: Command, inside: string | undefined): string | undefined {
  if (!inside) return undefined;
  if (cmd.kind === 'send' || cmd.kind === 'stop') {
    return `aw ${cmd.kind}: refused, because this shell looks like ${inside}. One agent must not drive another through aw; run it from your own terminal.`;
  }
  if (cmd.kind === 'rename' && cmd.ref !== undefined) {
    return `aw rename: refused, because this shell looks like ${inside}. Drop --session to name this conversation, or run it from your own terminal.`;
  }
  if (cmd.kind === 'web' && cmd.action === 'url') {
    return `aw web url: refused, because this shell looks like ${inside}. Run it from your own terminal, or use aw web open.`;
  }
  return webRefusal(cmd, inside);
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
