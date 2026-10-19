/**
 * What the table pane's Analytics view draws, and what its detail in the
 * conversation pane says (#49, plan §17–18). Every number and every sentence
 * is decided here, from `analytics.ts`: the webview only lays out strings and
 * posts back which filter changed or which item was clicked. It defines no
 * metric of its own.
 *
 * Computed in the main process (where the records are) for the selection the
 * pane last sent, and posted as a plain record.
 */
import {
  buildDataset,
  calibrationReport,
  computeMetric,
  dimensionValues,
  formatReported,
  hostedLocalSplit,
  HEADLINE_METRICS,
  isNotReported,
  METRIC_IDS,
  METRIC_LABELS,
  metricByGroup,
  notReportedText,
  UNKNOWN,
  type AnalyticsDataset,
  type AnalyticsFilter,
  type AnalyticsRecord,
  type CalibrationEntry,
  type GroupDimension,
  type MetricId,
  type MetricResult,
  type NotReported,
} from './analytics';
import { parseProposalRef, proposalEvidenceOf, proposalsView, type ProposalRef, type ProposalsInput, type ProposalsView } from './proposalsView';
import type { TierName } from './types';

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export type TimeRange = 'all' | '7d' | '30d' | '90d' | '365d';
const TIME_RANGES: readonly TimeRange[] = ['all', '7d', '30d', '90d', '365d'];
const TIME_LABEL: Record<TimeRange, string> = { all: 'All time', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days', '365d': 'Last year' };
const DAY_MS = 86_400_000;

/** The pane's filter choices. Absent: any. */
export interface AnalyticsSelection {
  kind?: string;
  tier?: string;
  effort?: string;
  model?: string;
  repository?: string;
  time?: TimeRange;
}

export type SelectionField = keyof AnalyticsSelection;
export const SELECTION_FIELDS: readonly SelectionField[] = ['kind', 'tier', 'effort', 'model', 'repository', 'time'];

/** A selection from the wire: strings only, unknown fields dropped. */
export function parseSelection(raw: unknown): AnalyticsSelection {
  const out: AnalyticsSelection = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  for (const f of SELECTION_FIELDS) {
    const v = r[f];
    if (typeof v !== 'string' || v === '') continue;
    if (f === 'time') {
      if ((TIME_RANGES as readonly string[]).includes(v)) out.time = v as TimeRange;
    } else out[f] = v;
  }
  return out;
}

export function selectionFilter(sel: AnalyticsSelection, now: number): AnalyticsFilter {
  const days = sel.time && sel.time !== 'all' ? Number(sel.time.slice(0, -1)) : undefined;
  return {
    ...(sel.kind ? { kind: sel.kind } : {}),
    ...(sel.tier ? { tier: sel.tier } : {}),
    ...(sel.effort ? { effort: sel.effort } : {}),
    ...(sel.model ? { model: sel.model } : {}),
    ...(sel.repository ? { repository: sel.repository } : {}),
    ...(days ? { from: now - days * DAY_MS } : {}),
  };
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** What a click in the view is about. Posted back as it is, to open its detail. */
export type AnalyticsRef =
  | { kind: 'metric'; id: MetricId }
  | { kind: 'split' }
  | { kind: 'candidate'; direction: 'under' | 'over'; key: string }
  | { kind: 'agreement'; group: 'dimension' | 'assessor' | 'scope'; key: string }
  | ProposalRef;

export interface FilterControlView {
  field: SelectionField;
  label: string;
  /** The first is "any" (value ''). */
  options: { value: string; label: string }[];
  selected: string;
}

export interface BarView {
  label: string;
  count: number;
  total: number;
  text: string;
}

export interface MetricCardView {
  ref: AnalyticsRef;
  id: MetricId;
  label: string;
  value: string;
  sub: string;
  /** The value itself is "not reported by …". */
  notReported: boolean;
  bars?: BarView[];
}

export interface SplitRowView {
  location: 'hosted' | 'local';
  label: string;
  attempts: string;
  success: string;
  cost: string;
}

export interface CandidateView {
  ref: AnalyticsRef;
  title: string;
  reason: string;
  /** Over-routing: the counterfactual is never observed. */
  heuristic: boolean;
  triggers: string;
  evidence: string;
}

export interface AgreementView {
  ref: AnalyticsRef;
  label: string;
  value: string;
  sub: string;
}

export interface AnalyticsView {
  selection: AnalyticsSelection;
  filters: FilterControlView[];
  /** First-attempt and eventual success, escalation rate, cost per successful task, model distribution. */
  headline: MetricCardView[];
  more: MetricCardView[];
  split: { ref: AnalyticsRef; rows: SplitRowView[]; note?: string };
  calibration: {
    under: CandidateView[];
    over: CandidateView[];
    /** The label every over-routing candidate carries. */
    heuristicLabel: string;
    heuristicNote: string;
    agreement: AgreementView[];
  };
  /** Routing-policy proposals from history, and the rules accepted from them (#52). Not narrowed by the filters: a cohort is its own filter. */
  proposals: ProposalsView;
  /** "12 tasks · 18 attempts" in the selection. */
  counts: string;
  /** Nothing recorded at all. */
  empty?: string;
}

export interface AnalyticsInput {
  records: readonly AnalyticsRecord[];
  tiers: readonly TierName[];
  repoOf?: (missionId: string) => string | undefined;
  selection: AnalyticsSelection;
  now: number;
  /** Decisions on proposals, and the veto. Absent: none made, nothing vetoed. */
  proposals?: Omit<ProposalsInput, 'tiers'> & { tiers?: readonly TierName[] };
}

function proposalsInput(input: AnalyticsInput): ProposalsInput {
  return { rules: input.proposals?.rules ?? [], rejected: input.proposals?.rejected ?? [], tiers: input.proposals?.tiers ?? input.tiers, ...(input.proposals?.veto ? { veto: input.proposals.veto } : {}) };
}

export const HEURISTIC_LABEL = 'heuristic';

// ---- formatting ----

export function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function usd(v: number): string {
  return v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`;
}

export function tokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** A repository as the view names it: the folder's name, never the whole path. */
export function repositoryLabel(repo: string): string {
  if (repo === UNKNOWN) return 'unknown repository';
  return repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A metric's value as the card shows it: never 0 for something nobody reported. */
export function metricValueText(r: MetricResult): string {
  const fmt = (v: number): string => {
    switch (r.unit) {
      case 'ratio':
        return pct(v);
      case 'usd-per':
      case 'usd':
        return usd(v);
      case 'tokens-per':
        return tokens(v);
      case 'ms':
        return duration(v);
      case 'count':
        return `${v}`;
      case 'distribution':
        return plural(v, r.id === 'model-distribution' ? 'model' : 'level');
    }
  };
  return formatReported<number>(r.value as number | NotReported | undefined, fmt);
}

function missingText(r: MetricResult): string {
  if (!r.missing || r.missing.harnesses.length === 0) return '';
  return ` · ${r.missing.ids.length} ${notReportedText(r.missing.harnesses)}`;
}

export function metricSubText(r: MetricResult): string {
  if (r.value === undefined) return `no ${r.of} in this selection`;
  if (isNotReported(r.value)) return `${plural(r.ids.length, 'record')}, none with this field`;
  switch (r.unit) {
    case 'ratio':
      return `${r.numerator} of ${r.denominator} ${r.of}`;
    case 'usd-per':
    case 'tokens-per':
      return `over ${r.denominator} ${r.of}${missingText(r)}`;
    case 'usd':
      return r.id === 'escalation-cost' ? `of ${usd(r.denominator)} total${missingText(r)}` : `over ${r.denominator} ${r.of}${missingText(r)}`;
    case 'ms':
    case 'count':
      return `over ${r.denominator} ${r.of}${missingText(r)}`;
    case 'distribution':
      return `${r.denominator} ${r.of}`;
  }
}

function card(r: MetricResult): MetricCardView {
  const bars =
    r.unit === 'distribution'
      ? (r.buckets ?? []).slice(0, 4).map((b) => ({ label: b.key, count: b.count, total: r.denominator, text: `${b.count} · ${pct(b.count / Math.max(1, r.denominator))}` }))
      : undefined;
  return {
    ref: { kind: 'metric', id: r.id },
    id: r.id,
    label: r.label,
    value: metricValueText(r),
    sub: metricSubText(r),
    notReported: isNotReported(r.value),
    ...(bars ? { bars } : {}),
  };
}

const REASON_TEXT: Record<CalibrationEntry['reason'], string> = {
  escalation: 'Needed a tier or effort step',
  rescue: 'Needed you to rescue it',
  'expert-small-diff': 'Expert tier on routine work, small diff, passed first time',
  'shadow-wanted-cheaper': 'Router wanted cheaper; the dearer route passed first time',
};

export function candidateKey(e: CalibrationEntry): string {
  return `${e.reason}|${e.taskKey}`;
}

function triggersText(t: CalibrationEntry['triggers']): string {
  return Object.entries(t)
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
}

function candidate(e: CalibrationEntry): CandidateView {
  return {
    ref: { kind: 'candidate', direction: e.direction, key: candidateKey(e) },
    title: `${e.kind ?? 'unassessed'} · ${e.taskId}`,
    reason: REASON_TEXT[e.reason],
    heuristic: e.heuristic,
    triggers: triggersText(e.triggers),
    evidence: plural(e.evidence.length, 'record'),
  };
}

const FILTER_DIMS: { field: Exclude<SelectionField, 'time'>; dim: GroupDimension; label: string }[] = [
  { field: 'kind', dim: 'kind', label: 'Kind' },
  { field: 'tier', dim: 'tier', label: 'Tier' },
  { field: 'effort', dim: 'effort', label: 'Effort' },
  { field: 'model', dim: 'model', label: 'Model' },
  { field: 'repository', dim: 'repository', label: 'Repository' },
];

function filterControls(ds: AnalyticsDataset, sel: AnalyticsSelection): FilterControlView[] {
  const controls: FilterControlView[] = FILTER_DIMS.map(({ field, dim, label }) => {
    const values = dimensionValues(ds, dim);
    const selected = sel[field] ?? '';
    // A selection the data no longer has stays selectable, so the pane never shows a blank.
    if (selected && !values.includes(selected)) values.push(selected);
    return {
      field,
      label,
      options: [{ value: '', label: `Any ${label.toLowerCase()}` }, ...values.map((v) => ({ value: v, label: field === 'repository' ? repositoryLabel(v) : v }))],
      selected,
    };
  });
  controls.push({ field: 'time', label: 'Time', options: TIME_RANGES.map((t) => ({ value: t === 'all' ? '' : t, label: TIME_LABEL[t] })), selected: sel.time && sel.time !== 'all' ? sel.time : '' });
  return controls;
}

function dataset(input: AnalyticsInput): AnalyticsDataset {
  return buildDataset({ records: input.records, tiers: input.tiers, ...(input.repoOf ? { repoOf: input.repoOf } : {}) });
}

export function analyticsView(input: AnalyticsInput): AnalyticsView {
  const ds = dataset(input);
  return viewOf(ds, input.selection, selectionFilter(input.selection, input.now), proposalsView(ds, proposalsInput(input), input.now));
}

function viewOf(ds: AnalyticsDataset, selection: AnalyticsSelection, f: AnalyticsFilter, proposals: ProposalsView): AnalyticsView {
  const metrics = new Map(METRIC_IDS.map((id) => [id, computeMetric(ds, f, id)]));
  const split = hostedLocalSplit(ds, f);
  const cal = calibrationReport(ds, f);
  const tasks = metrics.get('retry-rate')!.denominator;
  const attempts = metrics.get('model-distribution')!.denominator;

  const splitRow = (s: typeof split.hosted): SplitRowView => ({
    location: s.location,
    label: s.location === 'hosted' ? 'Hosted' : 'Local',
    attempts: plural(s.attempts, 'attempt'),
    success: s.successRate === undefined ? '—' : `${pct(s.successRate)} succeeded`,
    cost:
      s.location === 'local' && s.attempts > 0
        ? `$0 API cost${s.apiEquivalentUsd !== undefined ? ` · ≈${usd(s.apiEquivalentUsd)} hosted (estimate)` : ''}`
        : formatReported<number>(s.costUsd, usd, '—'),
  });
  const splitNote = split.noLocal
    ? 'Nothing ran on a local model in this selection.'
    : split.localCalls.total > 0
      ? `${plural(split.localCalls.total, 'direct local call')}, ${split.localCalls.ok} ok${split.localCalls.fellBackToHosted > 0 ? `, ${split.localCalls.fellBackToHosted} fell back to hosted` : ''}.`
      : undefined;

  const agreement: AgreementView[] = [
    ...cal.agreement.byDimension.map((r) => ({
      ref: { kind: 'agreement' as const, group: 'dimension' as const, key: r.key },
      label: `Kept the router's ${r.key}`,
      value: r.rate === undefined ? 'no data' : pct(r.rate),
      sub: `${r.agreed} of ${r.decisions} decisions`,
    })),
    {
      ref: { kind: 'agreement', group: 'scope', key: 'scope' },
      label: 'Scope accuracy',
      value: cal.agreement.scopeAccuracy.mean === undefined ? 'no data' : pct(cal.agreement.scopeAccuracy.mean),
      sub: `mean over ${plural(cal.agreement.scopeAccuracy.n, 'attempt')}`,
    },
    ...cal.agreement.byAssessorVersion.map((r) => ({
      ref: { kind: 'agreement' as const, group: 'assessor' as const, key: r.key },
      label: `Assessor ${r.key}`,
      value: r.rate === undefined ? 'no data' : pct(r.rate),
      sub: `${r.agreed} of ${r.decisions} routes kept${r.meanScopeAccuracy !== undefined ? ` · scope ${pct(r.meanScopeAccuracy)}` : ''}`,
    })),
  ];

  return {
    selection,
    filters: filterControls(ds, selection),
    headline: HEADLINE_METRICS.map((id) => card(metrics.get(id)!)),
    more: METRIC_IDS.filter((id) => !HEADLINE_METRICS.includes(id)).map((id) => card(metrics.get(id)!)),
    split: { ref: { kind: 'split' }, rows: [splitRow(split.hosted), splitRow(split.local)], ...(splitNote ? { note: splitNote } : {}) },
    calibration: {
      under: cal.under.map(candidate),
      over: cal.over.map(candidate),
      heuristicLabel: HEURISTIC_LABEL,
      heuristicNote: 'Over-routing is a guess: nobody saw the cheaper route run.',
      agreement,
    },
    proposals,
    counts: `${plural(tasks, 'task')} · ${plural(attempts, 'attempt')}`,
    ...(ds.tasks.length === 0 ? { empty: 'No orchestrated tasks recorded yet. Metrics appear here once tasks have run.' } : {}),
  };
}

// ---------------------------------------------------------------------------
// The detail (conversation pane)
// ---------------------------------------------------------------------------

export interface EvidenceView {
  id: string;
  type: string;
  when: string;
  summary: string;
}

export interface AnalyticsDetail {
  title: string;
  subtitle: string;
  /** Set on an over-routing candidate: the label shown beside the title. */
  heuristic?: string;
  facts: { label: string; value: string }[];
  breakdowns: { title: string; rows: { key: string; value: string; sub: string }[] }[];
  evidence: EvidenceView[];
  /** Evidence records behind it, of which `evidence` shows the first `EVIDENCE_LIMIT`. */
  evidenceTotal: number;
}

export const EVIDENCE_LIMIT = 200;

function when(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ');
}

/** One line per record: ids, enums and counts, nothing anyone wrote. */
export function evidenceSummary(r: AnalyticsRecord): string {
  switch (r.type) {
    case 'attempt':
      return `attempt ${r.n} · ${r.target.tier} · ${r.target.model} · ${r.outcome}${r.category ? ` (${r.category})` : ''}`;
    case 'routing':
      return `route for attempt ${r.attemptN} · ${r.mode} · ran ${r.ran.tier} · ${r.ran.model} · ${r.agreement}`;
    case 'escalation':
      return `after attempt ${r.afterAttemptN} · ${r.action}${r.blockedBy ? ` (blocked: ${r.blockedBy})` : ''} · ${r.category}`;
    case 'task-final':
      return `task ${r.outcome} · ${plural(r.attempts, 'attempt')}${r.firstAttemptPass ? ' · passed first time' : ''}${r.acceptedBy ? ` · accepted by ${r.acceptedBy}` : ''}`;
    case 'integration':
      return `integration ${r.event}${r.conflictingFiles !== undefined ? ` · ${plural(r.conflictingFiles, 'file')}` : ''}`;
    case 'override':
      return `override · ${r.scope} · ${r.changes.map((c) => c.field).join(', ')}`;
    case 'local-call':
      return `local call · ${r.purpose} · ${r.ok ? 'ok' : (r.failure ?? 'failed')}`;
    case 'plan':
      return `plan ${r.outcome} · ${plural(r.rounds, 'round')}`;
    case 'plan-review':
      return `plan review · ${plural(r.edits, 'edit')}`;
    case 'turn':
      return `turn · ${r.harness}`;
  }
}

function evidence(ds: AnalyticsDataset, ids: readonly string[]): { evidence: EvidenceView[]; evidenceTotal: number } {
  const unique = [...new Set(ids)];
  const out: EvidenceView[] = [];
  for (const id of unique.slice(0, EVIDENCE_LIMIT)) {
    const r = ds.byId.get(id);
    if (r) out.push({ id, type: r.type, when: when(r.at), summary: evidenceSummary(r) });
    else {
      // A task key (`mission|task`), for metrics counted per task.
      const t = ds.byKey.get(id);
      if (t) out.push({ id, type: 'task', when: when(t.at), summary: `${t.dims.kind ?? 'unassessed'} · ${plural(t.attempts.length, 'attempt')}` });
    }
  }
  return { evidence: out, evidenceTotal: unique.length };
}

const BREAKDOWN_DIMS: { dim: GroupDimension; title: string }[] = [
  { dim: 'kind', title: 'By kind' },
  { dim: 'tier', title: 'By tier' },
  { dim: 'model', title: 'By model' },
  { dim: 'repository', title: 'By repository' },
  { dim: 'harness', title: 'By harness' },
];

export function analyticsDetail(input: AnalyticsInput, ref: AnalyticsRef): AnalyticsDetail | undefined {
  const ds = dataset(input);
  const f = selectionFilter(input.selection, input.now);
  const scope = selectionText(input.selection);
  switch (ref.kind) {
    case 'proposal':
    case 'rule': {
      const p = proposalEvidenceOf(ds, proposalsInput(input), ref, input.now);
      if (!p) return undefined;
      return { title: p.title, subtitle: p.subtitle, facts: p.facts, breakdowns: [], ...evidence(ds, p.evidenceIds) };
    }
    case 'metric': {
      if (!METRIC_IDS.includes(ref.id)) return undefined;
      const r = computeMetric(ds, f, ref.id);
      const facts = [
        { label: 'Value', value: metricValueText(r) },
        { label: 'Numerator', value: r.unit === 'usd-per' || r.unit === 'usd' ? usd(r.numerator) : `${r.numerator}` },
        { label: 'Denominator', value: `${r.unit === 'usd' && r.id === 'escalation-cost' ? usd(r.denominator) : r.denominator} ${r.of}` },
        ...(r.missing && r.missing.ids.length > 0
          ? [{ label: 'Left out', value: `${plural(r.missing.ids.length, 'record')}${r.missing.harnesses.length > 0 ? `, ${notReportedText(r.missing.harnesses)}` : ', not recorded'}` }]
          : []),
        ...(r.buckets ?? []).map((b) => ({ label: b.key, value: `${b.count} · ${pct(b.count / Math.max(1, r.unit === 'distribution' ? r.denominator : r.ids.length))}` })),
      ];
      const breakdowns = BREAKDOWN_DIMS.map(({ dim, title }) => ({
        title,
        rows: metricByGroup(ds, f, ref.id, dim).map((g) => ({ key: dim === 'repository' ? repositoryLabel(g.key) : g.key, value: metricValueText(g.result), sub: metricSubText(g.result) })),
      })).filter((b) => b.rows.length > 0);
      return {
        title: METRIC_LABELS[ref.id],
        subtitle: scope,
        facts,
        breakdowns,
        ...evidence(ds, [...r.numeratorIds, ...r.ids]),
      };
    }
    case 'split': {
      const s = hostedLocalSplit(ds, f);
      const side = (x: typeof s.hosted) => [
        { label: `${x.location === 'hosted' ? 'Hosted' : 'Local'} attempts`, value: `${x.attempts}` },
        { label: `${x.location === 'hosted' ? 'Hosted' : 'Local'} success`, value: x.successRate === undefined ? '—' : `${pct(x.successRate)} (${x.succeeded} of ${x.attempts})` },
        { label: `${x.location === 'hosted' ? 'Hosted' : 'Local'} cost`, value: x.location === 'local' && x.attempts > 0 ? '$0 API cost' : formatReported<number>(x.costUsd, usd, '—') },
      ];
      return {
        title: 'Hosted vs local',
        subtitle: scope,
        facts: [
          ...side(s.hosted),
          ...side(s.local),
          ...(s.local.apiEquivalentUsd !== undefined ? [{ label: 'Hosted equivalent of local work (estimate)', value: usd(s.local.apiEquivalentUsd) }] : []),
          { label: 'Direct local calls', value: s.localCalls.total === 0 ? 'none' : `${s.localCalls.total} (${s.localCalls.ok} ok, ${s.localCalls.fellBackToHosted} fell back)` },
          ...(s.noLocal ? [{ label: 'Note', value: 'Nothing ran on a local model in this selection.' }] : []),
        ],
        breakdowns: [],
        ...evidence(ds, [...s.local.ids, ...s.localCalls.ids, ...s.hosted.ids]),
      };
    }
    case 'candidate': {
      const cal = calibrationReport(ds, f);
      const e = (ref.direction === 'under' ? cal.under : cal.over).find((x) => candidateKey(x) === ref.key);
      if (!e) return undefined;
      return {
        title: `${ref.direction === 'under' ? 'Under-routing' : 'Over-routing'}: ${e.kind ?? 'unassessed'} · ${e.taskId}`,
        subtitle: REASON_TEXT[e.reason],
        ...(e.heuristic ? { heuristic: HEURISTIC_LABEL } : {}),
        facts: [
          { label: 'Mission', value: e.missionId },
          { label: 'Task', value: e.taskId },
          ...Object.entries(e.triggers).map(([label, v]) => ({ label, value: String(v) })),
          ...(e.heuristic ? [{ label: 'Why heuristic', value: 'The cheaper route never ran, so this is a candidate, not a finding.' }] : []),
        ],
        breakdowns: [],
        ...evidence(ds, e.evidence),
      };
    }
    case 'agreement': {
      const a = calibrationReport(ds, f).agreement;
      if (ref.group === 'scope') {
        return {
          title: 'Scope accuracy',
          subtitle: scope,
          facts: [
            { label: 'Mean', value: a.scopeAccuracy.mean === undefined ? 'no data' : pct(a.scopeAccuracy.mean) },
            { label: 'Attempts', value: `${a.scopeAccuracy.n}` },
          ],
          breakdowns: [],
          ...evidence(ds, a.scopeAccuracy.evidence),
        };
      }
      const row = (ref.group === 'dimension' ? a.byDimension : a.byAssessorVersion).find((r) => r.key === ref.key);
      if (!row) return undefined;
      return {
        title: ref.group === 'dimension' ? `Router's ${row.key} kept` : `Assessor ${row.key}`,
        subtitle: scope,
        facts: [
          { label: 'Agreement', value: row.rate === undefined ? 'no data' : pct(row.rate) },
          { label: 'Agreed', value: `${row.agreed} of ${row.decisions} decisions` },
          ...(row.meanScopeAccuracy !== undefined ? [{ label: 'Scope accuracy', value: pct(row.meanScopeAccuracy) }] : []),
          ...(ref.group === 'dimension' ? [{ label: 'Evidence', value: `the ${plural(row.evidence.length, 'decision')} that changed it` }] : []),
        ],
        breakdowns: [],
        ...evidence(ds, row.evidence),
      };
    }
  }
}

/** "bugfix · standard · last 30 days", or "Everything recorded". */
export function selectionText(sel: AnalyticsSelection): string {
  const parts = [
    sel.kind,
    sel.tier,
    sel.effort,
    sel.model,
    sel.repository ? repositoryLabel(sel.repository) : undefined,
    sel.time && sel.time !== 'all' ? TIME_LABEL[sel.time].toLowerCase() : undefined,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' · ') : 'Everything recorded';
}

/** A ref from the wire, or undefined. */
export function parseRef(raw: unknown): AnalyticsRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'metric' && typeof r.id === 'string' && (METRIC_IDS as readonly string[]).includes(r.id)) return { kind: 'metric', id: r.id as MetricId };
  if (r.kind === 'split') return { kind: 'split' };
  if (r.kind === 'proposal' || r.kind === 'rule') return parseProposalRef(raw);
  if (r.kind === 'candidate' && (r.direction === 'under' || r.direction === 'over') && typeof r.key === 'string') return { kind: 'candidate', direction: r.direction, key: r.key };
  if (r.kind === 'agreement' && (r.group === 'dimension' || r.group === 'assessor' || r.group === 'scope') && typeof r.key === 'string') return { kind: 'agreement', group: r.group, key: r.key };
  return undefined;
}
