/**
 * One line saying what a permission prompt is *for*, from the hook payload's
 * `tool_input`. "Needs Bash" tells you a command wants to run; this tells you
 * which one, so the Allow button on the dashboard is a decision and not a
 * guess. Pure; the payload is foreign input and every field is optional.
 */
import * as path from 'node:path';

const MAX_CHARS = 160;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

/** Collapse whitespace and cap the length, so a multi-line command reads as one line. */
function line(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS - 1)}…` : flat;
}

/** A path relative to cwd when it is inside it, else the basename. */
function relPath(file: string, cwd: string | undefined): string {
  if (cwd && file.startsWith(`${cwd}${path.sep}`)) return file.slice(cwd.length + 1);
  return path.basename(file);
}

export function permissionDetail(
  toolName: string | undefined,
  toolInput: unknown,
  cwd?: string,
): string | undefined {
  if (typeof toolInput !== 'object' || toolInput === null) return undefined;
  const input = toolInput as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      // Claude's own one-line description of the command is the best summary
      // there is; the command itself is the fallback.
      const desc = str(input.description);
      const cmd = str(input.command);
      if (desc && cmd) return line(`${desc} — ${cmd}`);
      return desc ? line(desc) : cmd ? line(cmd) : undefined;
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'Read': {
      const file = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
      return file ? relPath(file, cwd) : undefined;
    }
    case 'WebFetch':
      return str(input.url) ? line(input.url as string) : undefined;
    case 'WebSearch':
      return str(input.query) ? line(input.query as string) : undefined;
    case 'AskUserQuestion': {
      // { questions: [{ question, header, options }] } — the first question is the ask.
      const qs = input.questions;
      if (Array.isArray(qs) && qs.length > 0 && typeof qs[0] === 'object' && qs[0] !== null) {
        const q = str((qs[0] as Record<string, unknown>).question);
        if (q) return line(qs.length > 1 ? `${q} (+${qs.length - 1} more)` : q);
      }
      return undefined;
    }
    case 'Agent':
    case 'Task':
      return str(input.description) ? line(input.description as string) : undefined;
    default: {
      // Unknown or MCP tool: the first string field is usually the subject.
      for (const key of ['description', 'command', 'file_path', 'path', 'url', 'query', 'prompt', 'name']) {
        const v = str(input[key]);
        if (v) return line(v);
      }
      for (const v of Object.values(input)) {
        if (str(v)) return line(v as string);
      }
      return undefined;
    }
  }
}
