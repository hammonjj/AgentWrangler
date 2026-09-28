import type { UsageError, UsageSnapshot, UsageWindow } from '../shared/usage';
import type { UsageReader } from '../core/usageService';
import type { CodexAppServer } from './appServer';
import { classifyCodexRateLimit, type RateLimitStoppage } from '../shared/rateLimitClassification';

interface CodexRateLimitWindow {
  usedPercent?: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

interface CodexRateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: CodexRateLimitWindow | null;
  secondary?: CodexRateLimitWindow | null;
}

interface CodexRateLimitsResponse {
  rateLimits?: CodexRateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, CodexRateLimitSnapshot> | null;
}

function durationLabel(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return 'Limit';
  if (minutes % 10_080 === 0) return `${minutes / 10_080} week`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440} day`;
  if (minutes % 60 === 0) return `${minutes / 60}hr`;
  return `${minutes}min`;
}

function toWindow(
  snapshot: CodexRateLimitSnapshot,
  bucket: 'primary' | 'secondary',
  includeLimitName: boolean,
): UsageWindow | undefined {
  const raw = snapshot[bucket];
  if (!raw || typeof raw.usedPercent !== 'number') return undefined;
  const limitId = snapshot.limitId ?? 'codex';
  const name = includeLimitName ? `${snapshot.limitName ?? limitId} · ` : '';
  return {
    id: `${limitId}:${bucket}`,
    label: `${name}${durationLabel(raw.windowDurationMins)}`,
    percent: Math.max(0, Math.min(100, raw.usedPercent)),
    resetsAtMs: typeof raw.resetsAt === 'number' ? raw.resetsAt * 1000 : undefined,
    active: false,
  };
}

/**
 * A window a snapshot actually reported as over its limit, classified (#75).
 *
 * `usedPercent >= 100` is the only "hit" signal the App Server response gives
 * us here — there is no explicit active-rate-limit flag in this payload — so
 * a window sitting at 80% is not a stoppage, only a card getting full.
 */
function windowStoppage(
  snapshot: CodexRateLimitSnapshot,
  bucket: 'primary' | 'secondary',
): RateLimitStoppage | undefined {
  const raw = snapshot[bucket];
  if (!raw || typeof raw.usedPercent !== 'number' || raw.usedPercent < 100) return undefined;
  return classifyCodexRateLimit({
    kind: 'codex-window',
    windowKind: bucket,
    limitId: snapshot.limitId ?? undefined,
    limitName: snapshot.limitName ?? undefined,
    resetsAtMs: typeof raw.resetsAt === 'number' ? raw.resetsAt * 1000 : undefined,
    raw: snapshot,
  });
}

/** Convert the stable App Server quota response into the dashboard's shared card model. */
export function parseCodexRateLimits(body: unknown, nowMs: number): UsageSnapshot | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const response = body as CodexRateLimitsResponse;
  const mapped = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length > 0
    ? Object.values(response.rateLimitsByLimitId).filter((value): value is CodexRateLimitSnapshot => !!value)
    : response.rateLimits ? [response.rateLimits] : [];
  const includeLimitName = mapped.length > 1;
  const windows = mapped.flatMap((snapshot) => [
    toWindow(snapshot, 'primary', includeLimitName),
    toWindow(snapshot, 'secondary', includeLimitName),
  ]).filter((window): window is UsageWindow => !!window);
  // `spendKnown: true` with no spend: Codex rate limits have no extra-usage
  // counterpart at all, so this is settled rather than unreported — there is
  // nothing for the service to carry forward from a previous read.
  return windows.length > 0 ? { fetchedAtMs: nowMs, windows, spendKnown: true } : undefined;
}

/** Every window in the response that is actually over its limit, classified. */
export function codexRateLimitStoppages(body: unknown): RateLimitStoppage[] {
  if (!body || typeof body !== 'object') return [];
  const response = body as CodexRateLimitsResponse;
  const mapped = response.rateLimitsByLimitId && Object.keys(response.rateLimitsByLimitId).length > 0
    ? Object.values(response.rateLimitsByLimitId).filter((value): value is CodexRateLimitSnapshot => !!value)
    : response.rateLimits ? [response.rateLimits] : [];
  return mapped.flatMap((snapshot) => [windowStoppage(snapshot, 'primary'), windowStoppage(snapshot, 'secondary')]).filter(
    (stoppage): stoppage is RateLimitStoppage => !!stoppage,
  );
}

/** App Server-backed reader used by the normal cached/polled UsageService. */
export function codexUsageReader(server: CodexAppServer): UsageReader {
  return async (nowMs) => {
    try {
      const response = await server.request('account/rateLimits/read', { excludeResetCreditDetails: true });
      const snapshot = parseCodexRateLimits(response, nowMs);
      if (snapshot) return { ok: true, snapshot };
      return { ok: false, error: { kind: 'bad-response', detail: 'No Codex rate-limit windows', atMs: nowMs } };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const lower = detail.toLowerCase();
      const kind: UsageError['kind'] = lower.includes('login') || lower.includes('auth')
        ? 'no-credentials'
        : lower.includes('429') || lower.includes('rate limit')
          ? 'rate-limited'
          : 'bad-response';
      return { ok: false, error: { kind, detail, atMs: nowMs } };
    }
  };
}
