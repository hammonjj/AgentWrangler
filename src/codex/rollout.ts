import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { capText, type ConvBlock } from '../shared/conversation';
import { needsReply } from '../core/needsReply';

const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 512 * 1024;

export interface CodexRolloutSummary {
  sessionId: string;
  path: string;
  cwd?: string;
  source?: string;
  isSubagent?: boolean;
  isGuardian?: boolean;
  parentThreadId?: string;
  title?: string;
  subtitle?: string;
  model?: string;
  gitBranch?: string;
  startedAtMs?: number;
  lastActivityAt: number;
  turnStartedAtMs?: number;
  turnComplete: boolean;
  lastAssistantText?: string;
  failed: boolean;
}

function textContent(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((part: any) => part && (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text'))
    .map((part: any) => part.text)
    .filter((text): text is string => typeof text === 'string')
    .join('\n')
    .trim();
  return text || undefined;
}

/** Setup messages have a user role too; never use them as conversation titles. */
function promptText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const stripped = text.replace(/<(recommended_plugins|environment_context)>[\s\S]*?<\/\1>/g, '').trim();
  if (!stripped || /^# AGENTS\.md instructions for /i.test(stripped)) return undefined;
  return stripped;
}

/** Codex app-only metadata appended after the visible final answer. */
export function visibleAssistantText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const visible = text.replace(/<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/gi, '').trim();
  return visible || undefined;
}

function parseLine(line: string): any | undefined {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeRolloutLines(lines: string[], filePath: string, mtimeMs: number): CodexRolloutSummary | undefined {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let source: string | undefined;
  let isSubagent = false;
  let isGuardian = false;
  let parentThreadId: string | undefined;
  let title: string | undefined;
  let subtitle: string | undefined;
  let model: string | undefined;
  let gitBranch: string | undefined;
  let startedAtMs: number | undefined;
  let turnStartedAtMs: number | undefined;
  let turnComplete = true;
  let lastAssistantText: string | undefined;
  let failed = false;

  for (const line of lines) {
    const obj = parseLine(line);
    if (!obj) continue;
    const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    const payload = obj.payload;
    if (obj.type === 'session_meta' && payload) {
      sessionId = typeof payload.id === 'string' ? payload.id : payload.session_id;
      cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd;
      let origin = payload.source;
      if (typeof origin === 'string' && origin.startsWith('{')) {
        try { origin = JSON.parse(origin); } catch { /* preserve unknown sources */ }
      }
      isSubagent = !!origin && typeof origin === 'object' && 'subagent' in origin;
      const agent = isSubagent ? origin.subagent : undefined;
      isGuardian = agent?.other === 'guardian';
      const parent = agent?.thread_spawn?.parent_thread_id;
      parentThreadId = typeof parent === 'string' && parent.trim() ? parent.toLowerCase() : undefined;
      source = isSubagent ? (isGuardian ? 'guardian' : 'subagent')
        : typeof origin === 'string' ? origin : payload.originator;
      model = typeof payload.model === 'string' ? payload.model : model;
      startedAtMs = Number.isFinite(ts) ? ts : startedAtMs;
      const branch = payload.git?.branch ?? payload.git_branch;
      gitBranch = typeof branch === 'string' ? branch : gitBranch;
      continue;
    }
    if (obj.type === 'turn_context' && payload) {
      cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd;
      model = typeof payload.model === 'string' ? payload.model : model;
      continue;
    }
    if (obj.type === 'event_msg' && payload?.type === 'task_started') {
      turnComplete = false;
      failed = false;
      turnStartedAtMs = typeof payload.started_at === 'number' ? payload.started_at * 1000 : Number.isFinite(ts) ? ts : undefined;
      continue;
    }
    if (obj.type === 'event_msg' && payload?.type === 'task_complete') {
      turnComplete = true;
      failed = !!payload.error;
      if (typeof payload.last_agent_message === 'string') lastAssistantText = visibleAssistantText(payload.last_agent_message);
      continue;
    }
    if (obj.type === 'event_msg' && payload?.type === 'user_message') {
      const text = promptText(typeof payload.message === 'string' ? payload.message : undefined);
      if (text) {
        subtitle = capText(text.replace(/\s+/g, ' '), 220);
        title ??= subtitle;
      }
      continue;
    }
    if (obj.type !== 'response_item' || !payload) continue;
    if (payload.type === 'message') {
      const rawText = textContent(payload.content);
      const text = payload.role === 'user' ? promptText(rawText) : rawText;
      if (!text) continue;
      if (payload.role === 'user') {
        subtitle = capText(text.replace(/\s+/g, ' '), 220);
        title ??= subtitle;
      } else if (payload.role === 'assistant' && payload.phase !== 'commentary') {
        lastAssistantText = visibleAssistantText(text);
      }
    }
  }

  if (!sessionId) {
    const match = /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(filePath);
    sessionId = match?.[1];
  }
  if (!sessionId) return undefined;
  return {
    sessionId,
    path: filePath,
    cwd,
    source,
    isSubagent,
    isGuardian,
    parentThreadId,
    title,
    subtitle,
    model,
    gitBranch,
    startedAtMs,
    lastActivityAt: mtimeMs,
    turnStartedAtMs,
    turnComplete,
    lastAssistantText,
    failed,
  };
}

async function readSlice(filePath: string, start: number, length: number): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readRolloutSummary(filePath: string): Promise<CodexRolloutSummary | undefined> {
  const stat = await fs.stat(filePath);
  const headLength = Math.min(stat.size, HEAD_BYTES);
  const tailStart = Math.max(headLength, stat.size - TAIL_BYTES);
  const [head, tail] = await Promise.all([
    readSlice(filePath, 0, headLength),
    tailStart < stat.size ? readSlice(filePath, tailStart, stat.size - tailStart) : Promise.resolve(''),
  ]);
  const tailText = tailStart > headLength ? tail.slice(Math.max(0, tail.indexOf('\n') + 1)) : tail;
  return summarizeRolloutLines(`${head}${tailText}`.split('\n'), filePath, stat.mtimeMs);
}

export function rolloutStatus(
  summary: CodexRolloutSummary,
  nowMs: number,
  stuckThresholdMs: number,
): 'busy' | 'stuck' | 'waiting' | 'done' {
  if (!summary.turnComplete) return nowMs - summary.lastActivityAt >= stuckThresholdMs ? 'stuck' : 'busy';
  if (summary.failed) return 'waiting';
  return needsReply(summary.lastAssistantText) ? 'waiting' : 'done';
}

function preview(value: unknown): string {
  if (typeof value === 'string') return capText(value.replace(/\s+/g, ' '), 300);
  try {
    return capText(JSON.stringify(value), 300);
  } catch {
    return '';
  }
}

function toolOutputText(value: unknown): string {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return value; }
  }
  if (Array.isArray(parsed)) {
    const text = parsed.map((part: any) => part?.text).filter((part): part is string => typeof part === 'string').join('\n');
    if (text) return text;
  }
  if (parsed && typeof parsed === 'object') {
    const content = (parsed as any).content;
    if (Array.isArray(content)) {
      const text = content.map((part: any) => part?.text).filter((part): part is string => typeof part === 'string').join('\n');
      if (text) return text;
    }
  }
  return preview(parsed);
}

function stableId(kind: string, timestamp: string | undefined, identity: string): string {
  // Rollout reads use a moving bounded tail. IDs based on array positions would
  // change as old records fall off that tail, so hash record identity instead.
  let hash = 2166136261;
  for (const char of `${kind}\u0000${timestamp ?? ''}\u0000${identity}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `cx:${kind}:${(hash >>> 0).toString(36)}`;
}

export function rolloutBlocks(lines: string[]): ConvBlock[] {
  const blocks: ConvBlock[] = [];
  const tools = new Map<string, number>();
  const patchTools = new Set<string>();
  for (const line of lines) {
    const obj = parseLine(line);
    if (!obj) continue;
    const payload = obj.payload;
    const ts = typeof obj.timestamp === 'string' ? obj.timestamp : undefined;
    if (obj.type === 'response_item' && payload?.type === 'message') {
      const rawText = textContent(payload.content);
      const text = payload.role === 'user' ? promptText(rawText) : visibleAssistantText(rawText);
      if (!text) continue;
      if (payload.role === 'user') blocks.push({ kind: 'user', id: stableId('user', ts, text), ts, text: capText(text) });
      if (payload.role === 'assistant') {
        const kind = payload.phase === 'commentary' ? 'thinking' : 'assistant';
        blocks.push({ kind, id: stableId(kind, ts, text), ts, text: capText(text) });
      }
      continue;
    }
    if (obj.type === 'response_item' && (payload?.type === 'function_call' || payload?.type === 'custom_tool_call')) {
      const toolUseId = String(payload.call_id ?? payload.id ?? `tool-${blocks.length}`);
      const name = String(payload.name ?? payload.tool_name ?? 'tool');
      const input = payload.arguments ?? payload.input;
      tools.set(toolUseId, blocks.length);
      blocks.push({ kind: 'tool', id: stableId('tool', ts, toolUseId), ts, toolUseId, name, inputPreview: preview(input), input, state: 'running' });
      continue;
    }
    if (obj.type === 'response_item' && (payload?.type === 'function_call_output' || payload?.type === 'custom_tool_call_output')) {
      const toolUseId = String(payload.call_id ?? payload.id ?? '');
      const index = tools.get(toolUseId);
      if (index === undefined) continue;
      const block = blocks[index];
      if (block.kind === 'tool') {
        if (patchTools.has(toolUseId)) continue;
        const text = toolOutputText(payload.output);
        blocks[index] = { ...block, state: 'done', result: { text: capText(text, 4000), isError: false, truncated: text.length > 4000 } };
      }
      continue;
    }
    if (obj.type === 'event_msg' && payload?.type === 'patch_apply_end') {
      const toolUseId = String(payload.call_id ?? '');
      const index = tools.get(toolUseId);
      if (index === undefined) continue;
      const block = blocks[index];
      if (block?.kind !== 'tool') continue;
      const changes = payload.changes && typeof payload.changes === 'object' ? Object.entries(payload.changes) : [];
      const diffs = changes.flatMap(([file, change]: [string, any]) =>
        typeof change?.unified_diff === 'string' ? [{ file, patch: change.unified_diff }] : []);
      const names = changes.map(([file]) => path.basename(file));
      patchTools.add(toolUseId);
      blocks[index] = {
        ...block,
        name: `Edited ${changes.length} file${changes.length === 1 ? '' : 's'}`,
        inputPreview: names.join(', '),
        input: undefined,
        state: payload.success === false ? 'error' : 'done',
        result: {
          text: payload.stderr ? String(payload.stderr) : '',
          isError: payload.success === false,
          truncated: false,
          diffs,
        },
      };
      continue;
    }
    if (obj.type === 'event_msg' && payload?.type === 'task_complete' && payload.error?.message) {
      const text = String(payload.error.message);
      blocks.push({ kind: 'note', id: stableId('note', ts, text), ts, tone: 'error', text: capText(text) });
    }
  }
  return blocks;
}

export async function readRolloutBlocks(filePath: string, maxBytes: number = TAIL_BYTES): Promise<{ blocks: ConvBlock[]; truncated: boolean }> {
  const stat = await fs.stat(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  let text = await readSlice(filePath, start, stat.size - start);
  if (start > 0) text = text.slice(Math.max(0, text.indexOf('\n') + 1));
  return { blocks: rolloutBlocks(text.split('\n')), truncated: start > 0 };
}

export async function findRollouts(root: string, cutoffMs: number): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) return;
      try {
        if ((await fs.stat(full)).mtimeMs >= cutoffMs) found.push(full);
      } catch { /* disappeared during the scan */ }
    }));
  }
  await walk(root);
  return found;
}
