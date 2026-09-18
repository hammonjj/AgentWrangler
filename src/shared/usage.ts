/**
 * Plan usage — the same numbers Claude Code's `/usage` screen shows, so the
 * dashboard can say where you stand without leaving it.
 *
 * Imported by BOTH the extension host and the webview bundle: no `vscode`,
 * Node, or DOM imports here. The fetch itself lives in `claude/usageFetch`.
 */

export type UsageSeverity = 'normal' | 'warning' | 'critical';

/** One rate-limit window: the 5-hour session, the 7-day all-models week, or a model-scoped week. */
export interface UsageWindow {
  /** Stable id for keying rows: `session`, `weekly_all`, `weekly_scoped:Fable`. */
  id: string;
  /** Card title, matching Claude Code's own labels: "Session (5hr)", "Weekly (7 day)", "Weekly Fable". */
  label: string;
  /** 0–100. The API reports whole percents; kept as a number in case that changes. */
  percent: number;
  /** ms epoch when the window resets; absent when the API sent none. */
  resetsAtMs?: number;
  /** True for the window currently constraining requests (the API's `is_active`). */
  active: boolean;
}

/** Extra-usage credits that cover you past the plan limits, when enabled on the account. */
export interface UsageSpend {
  usedMinor: number;
  limitMinor: number;
  exponent: number;
  currency: string;
  percent: number;
}

export interface UsageSnapshot {
  fetchedAtMs: number;
  windows: UsageWindow[];
  spend?: UsageSpend;
  /**
   * Whether this response actually said anything about extra usage.
   *
   * `spend` is optional in the body, and "absent" and "turned off" are not the
   * same fact — but both used to arrive here as `spend: undefined`, so a
   * response that simply omitted the block erased the card with no way to tell
   * that from the account genuinely having no credits. The windows never showed
   * this because they are always present; `spend` is the only optional half.
   *
   * True when the body was explicit either way (`enabled: false`, or `enabled:
   * true` with a limit). False when it said nothing, which is the caller's cue
   * to keep what it last knew rather than to conclude there is none.
   */
  spendKnown: boolean;
}

/**
 * Why there is no usage to show. `no-credentials`: no Claude Code login on this
 * machine (or an API-key setup, which has no plan usage). `unauthorized`: the
 * stored token was rejected — Claude Code refreshes it the next time it runs,
 * so this is usually transient. `network`/`bad-response`: the request failed.
 */
export type UsageErrorKind = 'no-credentials' | 'unauthorized' | 'rate-limited' | 'network' | 'bad-response';

export interface UsageError {
  kind: UsageErrorKind;
  detail?: string;
  atMs: number;
  /** For `rate-limited`: how long the server asked us to wait, when it said. */
  retryAfterMs?: number;
}

/** What the host pushes to the dashboard. `last` is the most recent good read, kept through errors. */
export interface UsageState {
  last?: UsageSnapshot;
  error?: UsageError;
}

// ---- parsing the /api/oauth/usage body ----

interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  severity?: string;
  resets_at?: string | null;
  scope?: { model?: { id?: string | null; display_name?: string | null } | null; surface?: string | null } | null;
  is_active?: boolean;
}

interface RawWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface RawSpend {
  enabled?: boolean;
  percent?: number;
  used?: { amount_minor?: number; currency?: string; exponent?: number } | null;
  limit?: { amount_minor?: number; currency?: string; exponent?: number } | null;
}

interface RawUsage {
  limits?: RawLimit[] | null;
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  seven_day_sonnet?: RawWindow | null;
  spend?: RawSpend | null;
}

function parseResetsAt(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : undefined;
}

function clampPercent(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, v));
}

function limitLabel(l: RawLimit): { id: string; label: string } {
  switch (l.kind) {
    case 'session':
      return { id: 'session', label: 'Session (5hr)' };
    case 'weekly_all':
      return { id: 'weekly_all', label: 'Weekly (7 day)' };
    default: {
      const model = l.scope?.model?.display_name ?? l.scope?.model?.id ?? undefined;
      const surface = l.scope?.surface ?? undefined;
      const scope = model ?? surface;
      const period = l.group === 'weekly' || l.kind?.startsWith('weekly') ? 'Weekly' : l.kind ?? 'Limit';
      return {
        id: `${l.kind ?? 'limit'}${scope ? `:${scope}` : ''}`,
        label: scope ? `${period} ${scope}` : period,
      };
    }
  }
}

/**
 * Windows from the body. Prefers the `limits` array (what Claude Code's usage
 * screen renders, and the only place the model-scoped week is labelled); falls
 * back to the older top-level windows when `limits` is absent.
 */
export function parseUsage(body: unknown, nowMs: number): UsageSnapshot | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as RawUsage;
  const windows: UsageWindow[] = [];

  if (Array.isArray(raw.limits) && raw.limits.length > 0) {
    for (const l of raw.limits) {
      if (!l || typeof l !== 'object') continue;
      const { id, label } = limitLabel(l);
      windows.push({
        id,
        label,
        percent: clampPercent(l.percent),
        resetsAtMs: parseResetsAt(l.resets_at),
        active: l.is_active === true,
      });
    }
  } else {
    const add = (id: string, label: string, w: RawWindow | null | undefined) => {
      if (!w || typeof w !== 'object') return;
      windows.push({ id, label, percent: clampPercent(w.utilization), resetsAtMs: parseResetsAt(w.resets_at), active: false });
    };
    add('session', 'Session (5hr)', raw.five_hour);
    add('weekly_all', 'Weekly (7 day)', raw.seven_day);
    add('weekly_scoped:Opus', 'Weekly Opus', raw.seven_day_opus);
    add('weekly_scoped:Sonnet', 'Weekly Sonnet', raw.seven_day_sonnet);
  }

  if (windows.length === 0) return undefined;

  // Three outcomes, not two. `enabled: false` is the account saying it has no
  // extra usage; a missing block is the response not mentioning it, which is
  // not the same claim and must not read as "there is none". See `spendKnown`.
  let spend: UsageSpend | undefined;
  let spendKnown = false;
  const sp = raw.spend;
  if (sp && typeof sp === 'object') {
    if (sp.enabled === false) {
      spendKnown = true;
    } else if (sp.enabled === true && sp.limit?.amount_minor !== undefined) {
      spendKnown = true;
      spend = {
        usedMinor: sp.used?.amount_minor ?? 0,
        limitMinor: sp.limit.amount_minor,
        exponent: sp.limit.exponent ?? sp.used?.exponent ?? 2,
        currency: sp.limit.currency ?? sp.used?.currency ?? 'USD',
        percent: clampPercent(sp.percent),
      };
    }
    // `enabled: true` with no limit says the feature is on but not how much of
    // it there is, which is not enough to draw a bar. Left unknown.
  }

  return { fetchedAtMs: nowMs, windows, spend, spendKnown };
}

// ---- presentation ----

/**
 * Colour band for a bar. The thresholds are the ones that matter in practice:
 * past 70% the week is worth planning around, past 90% it is about to bite.
 */
export function usageSeverity(percent: number): UsageSeverity {
  if (percent >= 90) return 'critical';
  if (percent >= 70) return 'warning';
  return 'normal';
}

/**
 * "Resets in 4h", "Resets in 35m", "Resets in 2d 3h" — the same granularity as
 * Claude Code's own panel, which never shows minutes once hours remain.
 */
export function resetsInText(nowMs: number, resetsAtMs: number | undefined): string {
  if (resetsAtMs === undefined) return '';
  const ms = resetsAtMs - nowMs;
  if (ms <= 0) return 'Resets now';
  const totalMin = Math.ceil(ms / 60_000);
  if (totalMin < 60) return `Resets in ${totalMin}m`;
  const totalH = Math.floor(totalMin / 60);
  if (totalH < 24) return `Resets in ${totalH}h`;
  const d = Math.floor(totalH / 24);
  const h = totalH - d * 24;
  return h > 0 ? `Resets in ${d}d ${h}h` : `Resets in ${d}d`;
}

/** "$3.50 of $1,000" for the extra-usage card. Minor units → major with the API's exponent. */
export function spendText(s: UsageSpend): string {
  const fmt = (minor: number) => {
    const major = minor / 10 ** s.exponent;
    // Whole amounts drop the cents ("$1,000"); anything else shows them all ("$3.50", never "$3.5").
    const whole = minor % 10 ** s.exponent === 0;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: s.currency,
        minimumFractionDigits: whole ? 0 : s.exponent,
        maximumFractionDigits: s.exponent,
      }).format(major);
    } catch {
      return `${major.toFixed(s.exponent)} ${s.currency}`;
    }
  };
  return `${fmt(s.usedMinor)} of ${fmt(s.limitMinor)}`;
}

/** One line for a tooltip or the status bar: "Session 54% · Week 49% · Fable 55%". */
export function usageSummaryLine(snap: UsageSnapshot): string {
  return snap.windows
    .map((w) => {
      const short =
        w.id === 'session' ? 'Session' : w.id === 'weekly_all' ? 'Week' : w.label.replace(/^Weekly\s+/, '');
      return `${short} ${Math.round(w.percent)}%`;
    })
    .join(' · ');
}

/** What the cards say when there is nothing to show; with numbers up it goes in the refresh button's tooltip. */
export function usageErrorText(e: UsageError): string {
  switch (e.kind) {
    case 'no-credentials':
      return 'No Claude Code login found on this machine, so plan usage is unavailable.';
    case 'unauthorized':
      return 'Claude rejected the stored login token. It refreshes the next time Claude Code talks to the API.';
    case 'rate-limited':
      return 'Claude is rate-limiting usage reads right now. Showing the last numbers; the next read is backed off.';
    case 'network':
      return `Could not reach Claude to read usage${e.detail ? ` (${e.detail})` : ''}.`;
    case 'bad-response':
      return `Claude returned something unexpected for usage${e.detail ? ` (${e.detail})` : ''}.`;
    default:
      return 'Usage is unavailable.';
  }
}
