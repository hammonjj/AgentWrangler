/**
 * How an orchestrated attempt is allowed to work
 * (`docs/plans/intelligent-orchestration.md` §24.1, decided 2026-09-24).
 *
 * Pure. An attempt does not inherit the launching session's permission mode:
 * it runs unattended in a throwaway worktree, so Claude attempts run in `auto`
 * with allow rules for the repository's own checks and for `git` inside the
 * worktree, and Codex attempts run sandboxed to the worktree. The app's
 * default mode is a ceiling: an attempt is never more permissive than it.
 * Hard denies hold in every mode. Nothing here comes from an agent or a
 * planner: the only inputs are the user's route, the user's repo policy and
 * AW's own paths (§24.1 caveat: `allowedTools` *grants*).
 */
import type { PermissionModeName } from '../../shared/conversation';
import type { LaunchPolicy } from '../../shared/launchPolicy';
import type { RepoPolicy } from '../../shared/orchestration/repoPolicy';
import type { HarnessId, Task } from '../../shared/orchestration/types';

/**
 * How much each mode lets happen without a person. `dontAsk` never prompts,
 * but it refuses whatever is not pre-approved, so it sits with `default`.
 * `bypassPermissions` is above every ceiling an attempt may have.
 */
const PERMISSIVENESS: Record<PermissionModeName, number> = {
  plan: 0,
  default: 1,
  dontAsk: 1,
  acceptEdits: 2,
  auto: 3,
  bypassPermissions: 4,
};

/** What an attempt runs in when the route names no mode (§24.1). */
export const ATTEMPT_PERMISSION_MODE: PermissionModeName = 'auto';

/**
 * The mode an attempt runs in: what the route asked for (default `auto`),
 * no more permissive than the app's default, and never `bypassPermissions`.
 */
export function attemptPermissionMode(requested: PermissionModeName | undefined, appDefault: PermissionModeName | undefined): PermissionModeName {
  let mode = requested ?? ATTEMPT_PERMISSION_MODE;
  const ceiling = appDefault ?? ATTEMPT_PERMISSION_MODE;
  if ((PERMISSIVENESS[mode] ?? 0) > (PERMISSIVENESS[ceiling] ?? 0)) mode = ceiling;
  // A ceiling of `bypassPermissions` still does not let an attempt bypass anything.
  if (mode === 'bypassPermissions') mode = ATTEMPT_PERMISSION_MODE;
  return mode;
}

/**
 * `git` subcommands an attempt may run without asking. All of them act on the
 * worktree the agent is in; none moves the branch to another commit it did
 * not make, talks to a remote or touches another worktree.
 *
 * An allow rule approves every argument after its prefix, so a subcommand
 * with an option that runs a program or writes a file anywhere is left out:
 * `grep` (`-O<cmd>`), and `diff`, `log` and `show` (`--output=<file>`). Those
 * stay with the permission mode, which asks or judges them one by one.
 */
export const WORKTREE_GIT = ['status', 'add', 'commit', 'restore', 'rm', 'mv', 'stash list', 'blame', 'ls-files', 'rev-parse'];

/**
 * Denied to every attempt, whatever its mode (§24.1). A deny rule wins over
 * the mode and over any allow. `app:install` is denied outright (G2):
 * finishing never installs (§13.3), and #68's lease only serialises installs.
 *
 * Rules match by prefix, so a spelling that puts something first
 * (`git -c x=y push`, `env git push`) is not caught here. It is not approved
 * either: it falls to the permission mode. The sandbox is Codex's; for Claude
 * these are a strong guard, not a wall.
 */
export const HARD_DENIED_COMMANDS = [
  'git push',
  'git worktree',
  'git checkout',
  'git switch',
  'git rebase',
  'git reset --hard',
  'git branch -D',
  'git branch -d',
  'git update-ref',
  'git -C',
  'git -c',
  'npm run app:install',
];

/** A Claude Code rule for a command and any arguments after it. */
function bashRule(command: string): string {
  return `Bash(${command}:*)`;
}

/** An absolute path in Claude Code's permission-rule syntax (`//` is the filesystem root). */
function absoluteRule(tool: 'Edit' | 'Write', dir: string): string {
  return `${tool}(/${dir.replace(/\/+$/, '')}/**)`;
}

/** An argv as the command line an agent would type, or undefined when a rule cannot say it exactly. */
function commandLine(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  // Rule syntax has no quoting; an argument a rule would misread is left to the agent's own prompt.
  if (argv.some((a) => a === '' || /[\s()"'`$\\*]/.test(a))) return undefined;
  return argv.join(' ');
}

export interface AttemptPolicyInput {
  harness: HarnessId;
  /** The primary checkout: never written by an attempt. */
  primaryRoot: string;
  /** The user's repo policy: its verification commands are the only commands allowed by name. */
  repoPolicy: RepoPolicy;
}

/**
 * The launch policy an attempt starts with, and gets back on every Resume
 * and migration (#71). Claude: allow rules for the repo's checks and
 * worktree-local `git`, hard denies. Codex: `workspace-write` with
 * `on-request`, and instructions not to commit (it cannot: §24.1; the core
 * commits for it).
 */
export function attemptLaunchPolicy(input: AttemptPolicyInput): LaunchPolicy {
  if (input.harness === 'codex') {
    return {
      codex: {
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
        developerInstructions: CODEX_INSTRUCTIONS,
      },
    };
  }
  const checks = Object.values(input.repoPolicy.verification.commands)
    .map((c) => commandLine(c.run))
    .filter((c): c is string => c !== undefined && !HARD_DENIED_COMMANDS.some((d) => c === d || c.startsWith(`${d} `)));
  const allowedTools = [...new Set([...checks.map(bashRule), ...WORKTREE_GIT.map((g) => bashRule(`git ${g}`))])];
  const disallowedTools = [
    ...HARD_DENIED_COMMANDS.map(bashRule),
    absoluteRule('Edit', input.primaryRoot),
    absoluteRule('Write', input.primaryRoot),
  ];
  return { claude: { allowedTools, disallowedTools } };
}

const CODEX_INSTRUCTIONS = [
  'You are running as an Agent Wrangler task, unattended, in a git worktree made for this task alone.',
  'Work only inside the current directory. Do not commit, stage or push: Agent Wrangler commits your changes on this branch when you finish.',
  'Do not ask to leave the sandbox; if the task cannot be done inside it, say so and stop.',
].join('\n');

/**
 * The attempt's first message. The user's objective and criteria, then how
 * this worktree works. It is sent to the agent only; telemetry never sees it.
 */
export function attemptPrompt(task: Pick<Task, 'title' | 'objective' | 'acceptanceCriteria'>, ctx: { harness: HarnessId; branch: string }): string {
  const lines = [`# Task: ${task.title}`, '', task.objective.trim()];
  const criteria = task.acceptanceCriteria.map((c) => c.trim()).filter(Boolean);
  if (criteria.length > 0) lines.push('', '## Acceptance criteria', ...criteria.map((c) => `- ${c}`));
  lines.push(
    '',
    '## How this task runs',
    `- You are in a git worktree of your own, on branch \`${ctx.branch}\`. Stay inside it.`,
    ctx.harness === 'codex'
      ? '- Do not commit: Agent Wrangler commits your changes on this branch when you finish.'
      : '- Commit your work on this branch as you go, with clear messages. Anything left uncommitted is committed for you when you finish.',
    '- Never push, never switch branches, and never run `npm run app:install`.',
    '- When the task is done, say so and stop. The result is reviewed as a diff of this branch.',
  );
  return lines.join('\n');
}
