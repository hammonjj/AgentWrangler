/**
 * What a permission prompt is *for*, from the hook payload's `tool_input`.
 * "Needs Bash" tells you a command wants to run; this tells you which one, so
 * the Allow button on the dashboard is a decision and not a guess.
 *
 * Two parts, kept apart: Claude's own one-line `description` (the summary) and
 * the literal thing that will happen (the command, the file, the question).
 * The dashboard shows the command on its own, monospaced, over as many lines as
 * it takes — joining them here would throw that away.
 *
 * Pure; the payload is foreign input and every field is optional.
 */
import * as path from 'node:path';
import type { PermissionAsk } from '../shared/model';

/** The summary is one line by definition. */
const MAX_SUMMARY = 200;
/** The body keeps its newlines, so it gets a budget rather than a line length. */
const MAX_BODY = 2000;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** Collapse whitespace and cap the length, so a wrapped description reads as one line. */
function line(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SUMMARY ? `${flat.slice(0, MAX_SUMMARY - 1)}…` : flat;
}

/** Trim the ends but keep the shape: a multi-line command is shown as it will run. */
function body(s: string): string {
  const trimmed = s.replace(/\s+$/, '').replace(/^\n+/, '');
  return trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY - 1)}…` : trimmed;
}

/** A path relative to cwd when it is inside it, else the basename. */
function relPath(file: string, cwd: string | undefined): string {
  if (cwd && file.startsWith(`${cwd}${path.sep}`)) return file.slice(cwd.length + 1);
  return path.basename(file);
}

function ask(a: PermissionAsk): PermissionAsk | undefined {
  return a.summary === undefined && a.body === undefined ? undefined : a;
}

export function permissionDetail(
  toolName: string | undefined,
  toolInput: unknown,
  cwd?: string,
): PermissionAsk | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const input = toolInput as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      const desc = str(input.description);
      const cmd = str(input.command);
      return ask({
        summary: desc ? line(desc) : undefined,
        body: cmd ? body(cmd) : undefined,
        isCommand: cmd !== undefined,
      });
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read': {
      const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
      return ask({ body: file ? relPath(file, cwd) : undefined });
    }
    case 'WebFetch':
      return ask({ summary: str(input.prompt) ? line(input.prompt as string) : undefined, body: str(input.url) });
    case 'WebSearch':
      return ask({ body: str(input.query) ? line(input.query as string) : undefined });
    case 'AskUserQuestion': {
      // { questions: [{ question, header, options }] } — the first question is the ask.
      const qs = input.questions;
      if (Array.isArray(qs) && qs.length > 0 && typeof qs[0] === 'object' && qs[0] !== null) {
        const q = str((qs[0] as Record<string, unknown>).question);
        if (q) return ask({ body: line(qs.length > 1 ? `${q} (+${qs.length - 1} more)` : q) });
      }
      return undefined;
    }
    case 'Agent':
    case 'Task':
      return ask({
        summary: str(input.description) ? line(input.description as string) : undefined,
        body: str(input.prompt) ? body(input.prompt as string) : undefined,
      });
    default: {
      // Unknown or MCP tool: the first string field is usually the subject.
      for (const key of ['description', 'command', 'file_path', 'path', 'url', 'query', 'prompt', 'name']) {
        const v = str(input[key]);
        if (v) return ask({ body: body(v), isCommand: key === 'command' });
      }
      for (const v of Object.values(input)) {
        if (str(v)) return ask({ body: body(v as string) });
      }
      return undefined;
    }
  }
}

// ---- "don't ask again" suggestions ----

/**
 * `permission_suggestions` on a `PermissionRequest` payload: the permission
 * updates Claude Code's own dialog would apply if you picked "don't ask again".
 * Handing the same list back in the hook's decision is what makes the
 * dashboard's *Always* button the same button (verified in the 2.1.268 binary:
 * an allow decision's `updatedPermissions` is applied to the session and
 * persisted).
 */
export interface PermissionSuggestion {
  type: string;
  /** userSettings | projectSettings | localSettings | session | cliArg. */
  destination: string;
  behavior?: string;
  rules?: { toolName: string; ruleContent?: string }[];
  directories?: string[];
}

const DESTINATIONS = new Set(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']);

/**
 * Keep only the suggestions that mean "stop asking me this": rules that add an
 * *allow*, and directory grants. A deny or an `ask` suggestion is a legitimate
 * thing for Claude Code to offer elsewhere, and would be exactly wrong to apply
 * from a button labelled Always allow. Anything malformed is dropped — Claude
 * Code validates the decision and ignores the whole allow if it does not parse.
 */
export function parsePermissionSuggestions(raw: unknown): PermissionSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionSuggestion[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    const destination = str(s.destination);
    if (!destination || !DESTINATIONS.has(destination)) continue;

    if (s.type === 'addRules') {
      if (s.behavior !== 'allow' || !Array.isArray(s.rules)) continue;
      const rules: { toolName: string; ruleContent?: string }[] = [];
      for (const r of s.rules) {
        if (typeof r !== 'object' || r === null) continue;
        const rule = r as Record<string, unknown>;
        const toolName = str(rule.toolName);
        if (!toolName) continue;
        rules.push({ toolName, ruleContent: str(rule.ruleContent) });
      }
      if (rules.length > 0) out.push({ type: 'addRules', destination, behavior: 'allow', rules });
    } else if (s.type === 'addDirectories') {
      const dirs = Array.isArray(s.directories) ? s.directories.filter((d): d is string => str(d) !== undefined) : [];
      if (dirs.length > 0) out.push({ type: 'addDirectories', destination, directories: dirs });
    }
  }
  return out;
}

/** How the rules read to a human — Claude Code's own `Tool(content)` spelling. */
export function suggestionLabels(suggestions: PermissionSuggestion[]): string[] {
  const labels: string[] = [];
  for (const s of suggestions) {
    for (const r of s.rules ?? []) labels.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    for (const d of s.directories ?? []) labels.push(`directory ${d}`);
  }
  return labels;
}

/** Where the rules land, in the words the dashboard tooltip uses. */
export function suggestionDestination(suggestions: PermissionSuggestion[]): string {
  switch (suggestions[0]?.destination) {
    case 'userSettings':
      return 'your user settings';
    case 'projectSettings':
      return "the project's settings";
    case 'localSettings':
      return "this project's local settings";
    case 'session':
      return 'this session only';
    default:
      return 'your Claude Code settings';
  }
}
