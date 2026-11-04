/**
 * Decide whether a subagent's permission ask is already covered by the allow
 * rules its parent session runs under. Pure: callers load the rules.
 *
 * Why this exists: Claude Code matches an allow rule against the whole command
 * string, so `Bash(git push:*)` does not cover
 * `git -C /path push origin x 2>&1 | tail -5`. A subagent runs many such
 * commands. Here the command is normalised and each part is matched on its own.
 * Any part that does not match leaves the ask for a human. Deny rules always win.
 */

export interface PermissionRules {
  allow: string[];
  deny: string[];
}

export const NO_RULES: PermissionRules = { allow: [], deny: [] };

/** `Bash(git push:*)` -> `{ tool: 'Bash', content: 'git push:*' }`; `Read` -> no content. */
export function parseRule(rule: string): { tool: string; content?: string } | undefined {
  const m = /^([A-Za-z0-9_:.\-]+)(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return undefined;
  return m[2] === undefined ? { tool: m[1] } : { tool: m[1], content: m[2] };
}

/** Split a shell command on `&&`, `||`, `;`, `|` outside quotes. `undefined` when it is not safely splittable. */
export function splitCommand(command: string): string[] | undefined {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"') {
        cur += c + (command[++i] ?? '');
        continue;
      }
      cur += c;
      continue;
    }
    // Anything that runs code we cannot see into: refuse to reason about it.
    if (c === '`' || (c === '$' && command[i + 1] === '(') || c === '\n' || c === '<' || c === '>' && command[i + 1] === '(') return undefined;
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (c === '&' && command[i + 1] === '&') {
      parts.push(cur);
      cur = '';
      i++;
    } else if (c === '|' && command[i + 1] === '|') {
      parts.push(cur);
      cur = '';
      i++;
    } else if (c === ';' || c === '|') {
      parts.push(cur);
      cur = '';
    } else if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') {
      // background `&`
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (quote) return undefined;
  parts.push(cur);
  const out = parts.map((p) => p.trim()).filter((p) => p !== '');
  return out.length ? out : undefined;
}

/** Drop harmless stderr/stdout merges and `git -C <path>` / `--no-pager`, so a rule for `git push` matches. */
export function normalizePart(part: string): string {
  let s = part.replace(/\s+\d?>&\d\b/g, '').replace(/\s+\d?>\s*\/dev\/null\b/g, '').trim();
  s = s.replace(/^git\s+(?:(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|--no-pager|--no-optional-locks)\s+)+/, 'git ');
  return s.replace(/\s+/g, ' ');
}

function bashRuleMatches(content: string, command: string): boolean {
  if (content === '*' || content === '') return true;
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2);
    return command === prefix || command.startsWith(prefix + ' ');
  }
  if (content.endsWith('*')) return command.startsWith(content.slice(0, -1));
  return command === content;
}

/** True when every part of the command matches an allow rule and none matches a deny rule. */
export function bashCommandAllowed(command: string, rules: PermissionRules): boolean {
  const parts = splitCommand(command);
  if (!parts) return false;
  const bash = (list: string[]) =>
    list.map(parseRule).filter((r): r is { tool: string; content?: string } => !!r && r.tool === 'Bash');
  const allow = bash(rules.allow);
  const deny = bash(rules.deny);
  // Deny is checked on the raw and the normalised form: stripping `-C` must not hide a denied command.
  for (const raw of [command, ...parts]) {
    const norm = normalizePart(raw);
    if (deny.some((r) => bashRuleMatches(r.content ?? '*', raw.trim()) || bashRuleMatches(r.content ?? '*', norm))) return false;
  }
  return parts.every((p) => {
    const norm = normalizePart(p);
    return allow.some((r) => r.content !== undefined && (bashRuleMatches(r.content, p.trim()) || bashRuleMatches(r.content, norm)));
  });
}

/** A non-Bash tool is covered when a bare `Tool` allow rule exists and no bare deny does. */
export function toolAllowed(toolName: string, rules: PermissionRules): boolean {
  const has = (list: string[]) => list.map(parseRule).some((r) => r?.tool === toolName && r.content === undefined);
  return has(rules.allow) && !has(rules.deny);
}

export interface SubagentAskFacts {
  toolName: string;
  input: Record<string, unknown>;
  /** The SDK `agentID`: set only for a subagent. */
  agentId?: string;
  /** The SDK `matchedAskRule`: a user `ask` rule forced this prompt. */
  matchedAskRule?: unknown;
}

/** Should AW answer this ask itself, from the parent's rules? Only subagent asks, only Bash and bare-tool rules. */
export function autoAllowSubagentAsk(ask: SubagentAskFacts, rules: PermissionRules): boolean {
  if (!ask.agentId || ask.matchedAskRule) return false;
  if (ask.toolName === 'Bash') {
    const command = typeof ask.input.command === 'string' ? ask.input.command : undefined;
    return command !== undefined && bashCommandAllowed(command, rules);
  }
  if (ask.toolName === 'AskUserQuestion' || ask.toolName === 'ExitPlanMode') return false;
  return toolAllowed(ask.toolName, rules);
}
