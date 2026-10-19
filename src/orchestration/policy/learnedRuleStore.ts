/**
 * The decisions a person made on routing proposals (`docs/plans/intelligent-orchestration.md`
 * §20.1; #52): the rules they accepted, each with the evidence it was accepted
 * on, and the proposals they rejected (so they are not made again at once).
 *
 * One small JSON file under the orchestration data directory, written
 * atomically. A file that does not parse is ignored whole and the router runs
 * without learned rules: a damaged file must never change a route. Nothing here
 * decides anything; it remembers what a person decided.
 */
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Disposable } from '../../core/events';
import { ruleFromProposal, type LearnedRule, type RejectedProposal, type RoutingProposal } from '../../shared/orchestration/routingProposals';
import { proposalVeto } from './learnedVeto';

export const LEARNED_RULES_VERSION = 1;

interface LearnedRulesFile {
  version: number;
  rules: LearnedRule[];
  rejected: RejectedProposal[];
}

export interface LearnedRuleFs {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  mkdirSync(dir: string, opts: { recursive: true }): unknown;
}

export function learnedRulesFile(dataDir: string): string {
  return path.join(dataDir, 'orchestration', 'learned-rules.json');
}

/** A rule with the fields the router reads, or undefined: a hand-edited file may say anything. */
function validRule(r: unknown): r is LearnedRule {
  if (!r || typeof r !== 'object') return false;
  const x = r as Partial<LearnedRule>;
  return (
    typeof x.id === 'string' &&
    (x.direction === 'downgrade' || x.direction === 'upgrade') &&
    typeof x.fromTier === 'string' &&
    typeof x.toTier === 'string' &&
    typeof x.acceptedAt === 'number' &&
    !!x.cohort &&
    typeof x.cohort.kind === 'string' &&
    !!x.evidence &&
    typeof x.evidence.observations === 'number'
  );
}

export class LearnedRuleStore {
  private data: LearnedRulesFile = { version: LEARNED_RULES_VERSION, rules: [], rejected: [] };
  private readonly changed = new Emitter<void>();
  readonly onDidChange = (listener: () => void): Disposable => this.changed.event(listener);

  constructor(
    private readonly file: string,
    private readonly fs: LearnedRuleFs = nodeFs,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.load();
  }

  private load(): void {
    let text: string;
    try {
      text = this.fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    try {
      const doc = JSON.parse(text) as Partial<LearnedRulesFile>;
      if (doc.version !== LEARNED_RULES_VERSION) throw new Error(`unknown version ${String(doc.version)}`);
      const rules = (doc.rules ?? []).filter(validRule);
      // A rule the veto refuses is never applied, however it got into the file.
      const safe = rules.filter((r) => {
        const why = proposalVeto(r);
        if (why.length > 0) this.log(`learned rules: ignoring ${r.id}: ${why[0]}`);
        return why.length === 0;
      });
      this.data = {
        version: LEARNED_RULES_VERSION,
        rules: safe,
        rejected: (doc.rejected ?? []).filter((r) => typeof r?.id === 'string' && typeof r.rejectedAt === 'number'),
      };
    } catch (e) {
      this.log(`learned rules: ignoring ${this.file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private save(): void {
    this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    this.fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    this.fs.renameSync(tmp, this.file);
    this.changed.fire();
  }

  rules(): readonly LearnedRule[] {
    return this.data.rules;
  }

  rejected(): readonly RejectedProposal[] {
    return this.data.rejected;
  }

  /**
   * Accept a proposal: it becomes a rule with its evidence attached. Refused
   * (and returns the reasons) when the corpus veto says it would commit an
   * egregious misroute.
   */
  accept(p: RoutingProposal, now: number): { ok: true; rule: LearnedRule } | { ok: false; reasons: string[] } {
    const rule = ruleFromProposal(p, now);
    const reasons = proposalVeto(rule);
    if (reasons.length > 0) return { ok: false, reasons };
    this.data = {
      ...this.data,
      rules: [...this.data.rules.filter((r) => r.id !== rule.id), rule],
      rejected: this.data.rejected.filter((r) => r.id !== rule.id),
    };
    this.save();
    return { ok: true, rule };
  }

  reject(id: string, now: number): void {
    this.data = { ...this.data, rejected: [...this.data.rejected.filter((r) => r.id !== id), { id, rejectedAt: now }] };
    this.save();
  }

  /** Remove an accepted rule: the deterministic policy applies again. */
  revoke(id: string): boolean {
    if (!this.data.rules.some((r) => r.id === id)) return false;
    this.data = { ...this.data, rules: this.data.rules.filter((r) => r.id !== id) };
    this.save();
    return true;
  }
}
