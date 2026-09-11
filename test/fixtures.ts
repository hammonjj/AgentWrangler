/** Builders for realistic Claude Code transcript JSONL lines. */

let uuidCounter = 0;
function fakeUuid(): string {
  const n = (uuidCounter++).toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${n}`;
}

const COMMON = {
  isSidechain: false,
  cwd: '/Users/test/proj',
  sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  version: '2.1.241',
  gitBranch: 'dev',
  slug: 'test-session-slug',
  entrypoint: 'claude-vscode',
};

export function mkUser(text: string | unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...COMMON,
    parentUuid: null,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: fakeUuid(),
    timestamp: '2026-08-24T17:00:00.000Z',
    userType: 'external',
    ...extra,
  });
}

export function mkAssistant(
  content: unknown[],
  stopReason: string | null,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    ...COMMON,
    parentUuid: fakeUuid(),
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      id: (extra.msgId as string) ?? 'msg_0001',
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { output_tokens: 10 },
    },
    requestId: 'req_x',
    uuid: fakeUuid(),
    timestamp: '2026-08-24T17:00:01.000Z',
    ...extra,
  });
}

export const mkText = (text: string) => ({ type: 'text', text });
export const mkThinking = (thinking: string) => ({ type: 'thinking', thinking });
export const mkToolUse = (name: string, input: Record<string, unknown>, id = 'toolu_x') => ({
  type: 'tool_use',
  id,
  name,
  input,
});
export const mkToolResult = (content: string, id = 'toolu_x', isError = false) => ({
  tool_use_id: id,
  type: 'tool_result',
  content,
  ...(isError ? { is_error: true } : {}),
});

export function mkAiTitle(title: string): string {
  return JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: COMMON.sessionId });
}

export function mkLastPrompt(prompt: string): string {
  return JSON.stringify({
    type: 'last-prompt',
    lastPrompt: prompt,
    leafUuid: fakeUuid(),
    sessionId: COMMON.sessionId,
  });
}

export function mkAtisLatch(): string {
  return JSON.stringify({ type: 'atis-latch', atis: '', sessionId: COMMON.sessionId });
}

export function mkQueueOp(op = 'enqueue'): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: op,
    timestamp: '2026-08-24T17:00:02.000Z',
    sessionId: COMMON.sessionId,
  });
}

export function mkPrLink(prNumber: number, prUrl: string, prRepository?: string): string {
  return JSON.stringify({ type: 'pr-link', sessionId: COMMON.sessionId, prNumber, prUrl, prRepository });
}

export function mkAttachment(): string {
  return JSON.stringify({
    ...COMMON,
    parentUuid: fakeUuid(),
    type: 'attachment',
    attachment: { type: 'total_tokens_reminder', text: '<total_tokens>1</total_tokens>' },
    uuid: fakeUuid(),
    timestamp: '2026-08-24T17:00:03.000Z',
  });
}

export function mkSidechainAssistant(): string {
  const line = JSON.parse(mkAssistant([mkText('subagent text')], 'end_turn'));
  line.isSidechain = true;
  line.agentId = 'a97e771fc7e52cd0';
  return JSON.stringify(line);
}

/** Join lines into a Buffer the way the file actually looks (trailing newline). */
export function toBuf(lines: string[], trailingNewline = true): Buffer {
  return Buffer.from(lines.join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
}
