/**
 * JSONL transcript lines → renderable viewer blocks. Pure (no fs, no vscode).
 */
import type { ViewerBlock } from '../shared/model';

const MAX_TEXT_CHARS = 6000;

function cap(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n… [truncated]` : text;
}

export function toolInputPreview(input: unknown): string {
  let s = '';
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const field of ['command', 'description', 'file_path', 'path', 'prompt', 'pattern', 'query', 'url', 'skill']) {
      if (typeof o[field] === 'string' && (o[field] as string).trim()) {
        s = o[field] as string;
        break;
      }
    }
    if (!s) {
      try {
        s = JSON.stringify(o);
      } catch {
        s = '';
      }
    }
  } else if (input !== undefined && input !== null) {
    s = String(input);
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

export function linesToBlocks(lines: string[]): ViewerBlock[] {
  const blocks: ViewerBlock[] = [];

  for (const line of lines) {
    if (!line) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object' || obj.isSidechain === true) continue;

    if (obj.type === 'user') {
      if (obj.isMeta === true) continue; // caveats, injected system context
      const c = obj.message?.content;
      let text = '';
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        // tool_result blocks are bulk output — only surface real text blocks
        text = c
          .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text)
          .join('\n');
      }
      text = text.trim();
      if (text) blocks.push({ kind: 'user', text: cap(text), ts: obj.timestamp });
    } else if (obj.type === 'assistant') {
      const c = obj.message?.content;
      if (!Array.isArray(c)) continue;
      const msgId = typeof obj.message?.id === 'string' ? obj.message.id : undefined;
      for (const b of c) {
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const last = blocks[blocks.length - 1];
          if (last && last.kind === 'assistant' && msgId !== undefined && last.msgId === msgId) {
            last.text = cap(`${last.text}\n${b.text}`);
          } else {
            blocks.push({ kind: 'assistant', text: cap(b.text), ts: obj.timestamp, msgId });
          }
        } else if (b && b.type === 'tool_use') {
          blocks.push({
            kind: 'tool',
            name: typeof b.name === 'string' ? b.name : 'tool',
            inputPreview: toolInputPreview(b.input),
            ts: obj.timestamp,
          });
        }
        // thinking blocks skipped
      }
    }
    // all other line types (attachment, ai-title, …) are not conversation content
  }

  return blocks;
}
