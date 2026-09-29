/**
 * Extract and track subagent list from Claude Code transcript.
 * Each Agent/Task tool_use gives id, description, and subagent_type.
 * A tool_result or task-notification marks it done; otherwise it's working.
 */
import type { SubagentInfo } from '../shared/model';
import type { SummaryPartial } from './transcriptTail';

/**
 * Track for incremental subagent updates: stores open subagents and their state.
 */
export interface SubagentListState {
  /** Map of id -> SubagentInfo for currently tracked subagents. */
  open: Map<string, SubagentInfo>;
}

export function createSubagentListState(): SubagentListState {
  return { open: new Map() };
}

/**
 * Parse a line of transcript to extract subagent launches and completions.
 * Returns updates to the state that should be applied.
 */
export function parseSubagentLineUpdates(
  line: string,
): { opened?: Array<{ id: string; label: string; agentType?: string }>; closed?: string[] } | undefined {
  if (!line) return undefined;
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') return undefined;

  const opened: Array<{ id: string; label: string; agentType?: string }> = [];
  const closed: string[] = [];

  // Check for Agent/Task tool_use
  if (obj.type === 'assistant' && obj.message?.content) {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') {
          const toolName = block.name;
          if (toolName === 'Agent' || toolName === 'Task') {
            const input = block.input;
            if (input && typeof input === 'object') {
              const id = input.subagent_id ?? input.task_id;
              if (typeof id === 'string' && id) {
                const label = input.description ?? id.slice(0, 8);
                const agentType = input.subagent_type;
                opened.push({ id, label, agentType });
              }
            }
          }
        }
      }
    }
  }

  // Check for tool_result or task-notification
  if (obj.type === 'user' && obj.message?.content) {
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result') {
          const toolUseId = block.tool_use_id;
          if (typeof toolUseId === 'string') {
            // Mark as closed
            closed.push(toolUseId);
          }
        }
      }
    }
  }

  // Check for task-notification close
  if (obj.type === 'task-notification' && typeof obj.task_id === 'string') {
    closed.push(obj.task_id);
  }

  return (opened.length > 0 || closed.length > 0)
    ? { opened: opened.length > 0 ? opened : undefined, closed: closed.length > 0 ? closed : undefined }
    : undefined;
}

/**
 * Update subagent state and return a list of currently tracked subagents.
 * Cap the list size to prevent unbounded growth.
 */
export function updateSubagentState(
  state: SubagentListState,
  opened?: Array<{ id: string; label: string; agentType?: string }>,
  closed?: string[],
): SubagentInfo[] {
  // Mark opened subagents as working
  if (opened) {
    for (const item of opened) {
      state.open.set(item.id, {
        id: item.id,
        label: item.label,
        agentType: item.agentType,
        status: 'working',
        lastActivityAt: Date.now(),
      });
    }
  }

  // Mark closed subagents as done
  if (closed) {
    for (const id of closed) {
      const existing = state.open.get(id);
      if (existing) {
        state.open.set(id, { ...existing, status: 'done', lastActivityAt: Date.now() });
      }
    }
  }

  // Return sorted list, capped at a reasonable size
  const list = Array.from(state.open.values());
  if (list.length > 100) {
    // Keep the most recently updated items
    list.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    list.length = 100;
  }

  return list;
}

/**
 * Merge subagent information into transcript summary partial.
 * This is called during incremental parsing.
 */
export function mergeSubagentListPartial(
  state: SubagentListState,
  partial: SummaryPartial & { subagentListOpened?: Array<{ id: string; label: string; agentType?: string }>; subagentListClosed?: string[] },
): SubagentInfo[] {
  return updateSubagentState(state, partial.subagentListOpened, partial.subagentListClosed);
}

/**
 * Mark any still-open subagents as done (for ended sessions).
 */
export function closeAllSubagents(state: SubagentListState): SubagentInfo[] {
  const now = Date.now();
  for (const info of state.open.values()) {
    if (info.status === 'working') {
      info.status = 'done';
      info.lastActivityAt = now;
    }
  }
  return Array.from(state.open.values());
}
