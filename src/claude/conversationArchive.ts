/** On-demand archive reads. Stream JSONL so paging/search do not load the file into RAM. */
import { createReadStream } from 'node:fs';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { createTranscriptState, reduceTranscriptLines } from './transcriptBlocks';
import type { ConvBlock } from '../shared/conversation';

export async function archivePage(file: string, before?: string, query = '', sidechain = false, beforeTime?: string) {
  const state = createTranscriptState();
  const blocks: ConvBlock[] = [];
  const candidates = new Map<string, ConvBlock>();
  let lastAssistant: string | undefined;
  const select = (block: ConvBlock) => {
    const full = state.overflow.get(block.id);
    if (query && !(full ?? JSON.stringify(block)).toLowerCase().includes(query.toLowerCase())) return;
    const index = blocks.findIndex((b) => b.id === block.id);
    if (index >= 0) blocks[index] = block;
    else blocks.push(block);
    if (blocks.length > 100) { blocks.shift(); more = true; }
  };
  let more = false;
  let reached = false;
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (let line of lines) {
      if (sidechain) {
        try { const obj = JSON.parse(line); obj.isSidechain = false; line = JSON.stringify(obj); } catch { continue; }
      }
      const reduced = reduceTranscriptLines(state, [line]);
      for (const patch of reduced.patches) {
        const index = blocks.findIndex((b) => b.id === patch.id);
        if (index >= 0) blocks[index] = { ...blocks[index], ...patch.block } as ConvBlock;
        const candidate = candidates.get(patch.id);
        if (query && candidate) {
          const next = { ...candidate, ...patch.block } as ConvBlock;
          candidates.set(next.id, next); select(next);
          if (next.kind === 'tool' && next.state !== 'running') candidates.delete(next.id);
        }
      }
      for (const block of reduced.appends) {
        if (block.id === before) reached = true;
        if (reached) continue;
        if (beforeTime && (!('ts' in block) || !block.ts || Date.parse(block.ts) >= Date.parse(beforeTime))) continue;
        if (lastAssistant) candidates.delete(lastAssistant);
        lastAssistant = block.kind === 'assistant' ? block.id : undefined;
        if (query && (block.kind === 'tool' || block.kind === 'assistant')) candidates.set(block.id, block);
        select(block);
      }
    }
  } finally { lines.close(); input.destroy(); }
  // A cursor that fell outside this transcript must not silently duplicate the current page.
  if (before && !reached) throw new Error('History cursor was not found. Reopen the conversation to refresh it.');
  return { blocks, more, overflow: state.overflow };
}

export async function archivedTool(file: string, toolUseId: string): Promise<{ text?: string; agentId?: string }> {
  const input = createReadStream(file);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let result: { text?: string; agentId?: string } = {};
  try {
    for await (const line of lines) {
      let obj: any; try { obj = JSON.parse(line); } catch { continue; }
      if (!Array.isArray(obj.message?.content)) continue;
      for (const block of obj.message.content) {
        if (block.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue;
        const content = block.content;
        result = {
          text: typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : '',
          agentId: typeof obj.toolUseResult?.agentId === 'string' ? obj.toolUseResult.agentId : undefined,
        };
      }
    }
    return result;
  } finally { lines.close(); input.destroy(); }
}

export function subagentPath(file: string, agentId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error('Invalid subagent identifier');
  return path.join(file.replace(/\.jsonl$/, ''), 'subagents', `agent-${agentId}.jsonl`);
}
