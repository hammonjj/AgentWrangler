/**
 * A session's launch policy: the tool rules, limits and sandbox settings it
 * was started with, which have to hold for its whole life
 * (`docs/plans/intelligent-orchestration.md` §24.1, ask A7; #71).
 *
 * It is part of how a session was launched, like its model and effort: it
 * travels on `LaunchRequest`, crosses to a session host in `HostBoot`, is
 * recorded in the registry's launch record and the host manifest, and is
 * applied again every time the session is resumed, moved to a new host (§7.4)
 * or rejoined (Codex `thread/resume`, reattach included). A policy set once and
 * dropped on Resume would silently lose its deny rules, which is why it is
 * carried end to end rather than set at start.
 *
 * Data only. The host and the executors apply it and decide nothing. Each
 * provider reads its own half and ignores the other.
 *
 * Deliberately narrower than what the agents accept: there is no permission
 * mode here (that is `LaunchRequest.permissionMode`), nothing that could turn
 * on `bypassPermissions` or `allowDangerouslySkipPermissions`, and no Codex
 * `danger-full-access` sandbox. `parseLaunchPolicy` drops anything else, so a
 * value read back from disk can never widen what was asked for.
 *
 * Pure types and one pure parser. No Node, no DOM, no SDK import: this file is
 * bundled into the webviews too.
 */

/** Claude Code: SDK `Options` fields, applied at every start of the agent. */
export interface ClaudeLaunchPolicy {
  /** Allow rules, in Claude Code's permission-rule syntax (`Bash(npm test:*)`). */
  allowedTools?: string[];
  /** Deny rules, same syntax. A deny wins over the permission mode and over any allow. */
  disallowedTools?: string[];
  /** Most agentic turns per start. */
  maxTurns?: number;
  /** Spend cap, in USD, per start. */
  maxBudgetUsd?: number;
  /** Model to fall back to when the primary is unavailable. */
  fallbackModel?: string;
  /** Structured output for the final result. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

/** Codex sandboxes AW will ask for. `danger-full-access` is never one of them. */
export type CodexSandbox = 'read-only' | 'workspace-write';
/** Codex approval policies AW will ask for (the app-server's `AskForApproval`, minus `granular`). */
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';

/** Codex: `thread/start` and `thread/resume` params, sent on every one. */
export interface CodexLaunchPolicy {
  sandbox?: CodexSandbox;
  approvalPolicy?: CodexApprovalPolicy;
  developerInstructions?: string;
}

export interface LaunchPolicy {
  claude?: ClaudeLaunchPolicy;
  codex?: CodexLaunchPolicy;
}

const SANDBOXES: readonly string[] = ['read-only', 'workspace-write'] satisfies CodexSandbox[];
const APPROVALS: readonly string[] = ['untrusted', 'on-request', 'never'] satisfies CodexApprovalPolicy[];

/**
 * A policy from anywhere that is not typed (a registry file, a manifest, the
 * boot line), keeping only fields of the right shape. Undefined when nothing
 * valid is left, so "no policy" has one representation.
 */
export function parseLaunchPolicy(raw: unknown): LaunchPolicy | undefined {
  if (!isObject(raw)) return undefined;
  const claude = parseClaude(raw.claude);
  const codex = parseCodex(raw.codex);
  if (!claude && !codex) return undefined;
  return { ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) };
}

function parseClaude(raw: unknown): ClaudeLaunchPolicy | undefined {
  if (!isObject(raw)) return undefined;
  const out: ClaudeLaunchPolicy = {};
  const allowed = stringList(raw.allowedTools);
  if (allowed) out.allowedTools = allowed;
  const denied = stringList(raw.disallowedTools);
  if (denied) out.disallowedTools = denied;
  if (typeof raw.maxTurns === 'number' && Number.isInteger(raw.maxTurns) && raw.maxTurns > 0) out.maxTurns = raw.maxTurns;
  if (typeof raw.maxBudgetUsd === 'number' && Number.isFinite(raw.maxBudgetUsd) && raw.maxBudgetUsd > 0) out.maxBudgetUsd = raw.maxBudgetUsd;
  if (typeof raw.fallbackModel === 'string' && raw.fallbackModel.trim()) out.fallbackModel = raw.fallbackModel.trim();
  const format = raw.outputFormat;
  if (isObject(format) && format.type === 'json_schema' && isObject(format.schema)) {
    out.outputFormat = { type: 'json_schema', schema: format.schema };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseCodex(raw: unknown): CodexLaunchPolicy | undefined {
  if (!isObject(raw)) return undefined;
  const out: CodexLaunchPolicy = {};
  if (typeof raw.sandbox === 'string' && SANDBOXES.includes(raw.sandbox)) out.sandbox = raw.sandbox as CodexSandbox;
  if (typeof raw.approvalPolicy === 'string' && APPROVALS.includes(raw.approvalPolicy)) {
    out.approvalPolicy = raw.approvalPolicy as CodexApprovalPolicy;
  }
  if (typeof raw.developerInstructions === 'string' && raw.developerInstructions.trim()) {
    out.developerInstructions = raw.developerInstructions;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((r): r is string => typeof r === 'string' && r.trim() !== '').map((r) => r.trim());
  return list.length > 0 ? list : undefined;
}

function isObject(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}
