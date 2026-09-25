/**
 * What a session has used so far, summed from its per-turn telemetry records
 * (#27), and how the table and the conversation header say it (#28).
 *
 * Imported by the main process and the webviews: no Node or DOM here.
 *
 * The rule the formatters keep: a session with no records has no usage at all
 * (`undefined`, and nothing is shown), and a figure the agent did not report is
 * said to be unreported, never shown as zero. The webview never asks which
 * agent it is; the aggregate already says what is known.
 */
import type { CostBasis } from './orchestration/types';

export interface SessionUsage {
  /** Turns recorded. */
  turns: number;
  /** Turns whose usage could not be worked out (zeroed or dropping totals, nothing reported). */
  unknownTurns: number;
  /**
   * Tokens summed over the turns that reported them. `total` counts every
   * token once whatever the agent's convention (Claude reports cached input
   * separately; Codex counts it inside input).
   */
  tokens: { total: number; input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Summed over the turns that had a cost. Absent when none did. */
  costUsd?: number;
  /** Where the cost comes from; `mixed` when turns disagree. `none`: nothing reported a cost. */
  costBasis: CostBasis | 'mixed';
  /** Turns with usage but no cost, while others had one: the cost is then a lower bound. */
  uncostedTurns: number;
  /** Models used, the one with the most output first. */
  models: string[];
  /** The latest turn's effort: what AW asked for and what the agent said it ran at. */
  effort: { requested?: string; applied?: string };
  /** Some records cover turns that finished while Agent Wrangler was not running. */
  coversGap: boolean;
  /** When the latest turn was recorded. */
  lastAt: number;
}

/** "940", "12.3k", "340k", "3.1M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

/** "<$0.01", "$1.94", "$24.2", "$145". */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  if (usd < 10) return `$${usd.toFixed(2)}`;
  if (usd < 100) return `$${usd.toFixed(1)}`;
  return `$${Math.round(usd)}`;
}

/** How the cost is labelled in the cell: short, but never without its basis. */
function costPart(u: SessionUsage): string {
  if (u.costUsd === undefined || u.costBasis === 'none') return 'cost not reported';
  const amount = `${formatUsd(u.costUsd)}${u.uncostedTurns > 0 ? '+' : ''}`;
  switch (u.costBasis) {
    case 'harness-estimate':
      return `${amount} est`;
    case 'price-table':
      return `${amount} priced`;
    default:
      return `${amount} mixed`;
  }
}

/** The table cell and the narrow second line: "3.1M tok · $24.2 est". */
export function usageCellText(u: SessionUsage): string {
  if (u.turns === u.unknownTurns) return 'usage not reported';
  return `${formatTokens(u.tokens.total)} tok · ${costPart(u)}`;
}

function basisSentence(u: SessionUsage): string {
  switch (u.costBasis) {
    case 'harness-estimate':
      return 'Cost is the agent\'s own estimate: what these tokens would cost through the API, not a bill.';
    case 'price-table':
      return 'Cost is estimated from the prices in the telemetry.prices setting.';
    case 'mixed':
      return 'Cost mixes the agent\'s own estimate and the telemetry.prices setting.';
    default:
      return 'This agent reports no cost. Set per-model prices in telemetry.prices to estimate one.';
  }
}

/** The tooltip: every figure, in full, with what is and is not known. */
export function usageTitle(u: SessionUsage): string {
  const t = u.tokens;
  const lines = [
    `${u.turns} turn${u.turns === 1 ? '' : 's'} recorded.`,
    `Tokens: ${t.total.toLocaleString('en-US')} (input ${t.input.toLocaleString('en-US')}, output ${t.output.toLocaleString('en-US')}, cache read ${t.cacheRead.toLocaleString('en-US')}, cache write ${t.cacheWrite.toLocaleString('en-US')}).`,
  ];
  if (u.costUsd !== undefined && u.costBasis !== 'none') lines.push(`Cost: $${u.costUsd.toFixed(4)}.`);
  lines.push(basisSentence(u));
  if (u.uncostedTurns > 0) lines.push(`${u.uncostedTurns} turn${u.uncostedTurns === 1 ? ' has' : 's have'} no cost, so the total is a lower bound.`);
  if (u.unknownTurns > 0) lines.push(`${u.unknownTurns} turn${u.unknownTurns === 1 ? '' : 's'} reported no usable usage.`);
  if (u.coversGap) lines.push('Includes turns that finished while Agent Wrangler was not running.');
  if (u.models.length > 0) lines.push(`Models: ${u.models.join(', ')}.`);
  return lines.join('\n');
}

/**
 * The conversation header's usage line: models, effort (requested → applied,
 * with "unknown" where the agent did not say), tokens and cost with its basis.
 */
export function usageHeaderText(u: SessionUsage, modelName: (id: string) => string = (id) => id): string {
  const parts: string[] = [];
  if (u.models.length > 0) parts.push(u.models.map(modelName).join(' + '));
  if (u.effort.requested !== undefined || u.effort.applied !== undefined) {
    const applied = u.effort.applied ?? 'unknown';
    parts.push(
      u.effort.requested !== undefined && u.effort.requested !== u.effort.applied
        ? `effort ${u.effort.requested} → ${applied}`
        : `effort ${applied}`,
    );
  } else {
    parts.push('effort unknown');
  }
  parts.push(usageCellText(u));
  return parts.join(' · ');
}
