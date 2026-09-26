/**
 * The live assessor evaluation (plan §27.2; #39): every corpus card's text
 * through the real assessor — rules plus one `haiku` completion — scored
 * against the card's labels, exact and within one level, per dimension.
 *
 * Opt-in (`AW_LIVE_ASSESSOR=1`): it spends one small completion per card.
 * The run writes `test/fixtures/routing-corpus/recorded/<assessor version>.json`
 * — the model's structured answers and the agreement numbers — which
 * `routingCorpus.test.ts` replays deterministically in every `npm test`.
 * Commit it when the numbers are worth keeping: the cards are invented, so
 * the answers are public-safe. What is printed is numbers only.
 *
 *   AW_LIVE_ASSESSOR=1 npx vitest run test/orchestration/routingCorpus.live.test.ts
 */
import * as fs from 'node:fs';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { resolveClaudeBinary } from '../../src/claude/binary';
import { ClaudeStructuredCompletion, type CompletionQueryFn, type StructuredCompletion } from '../../src/orchestration/completion/structuredCompletion';
import { ASSESSOR_VERSION, type ModelAnswer } from '../../src/orchestration/policy/assessment';
import { Assessor } from '../../src/orchestration/policy/assessor';
import { corpusRouter } from './corpusRouter';
import {
  CARD_ROOT,
  RECORDINGS_DIR,
  addAgreement,
  cardFs,
  cardHash,
  cardPolicy,
  cardTask,
  emptyAgreement,
  evaluateCard,
  formatAgreement,
  loadCorpus,
  recordingPath,
  type CorpusCard,
  type Recording,
} from './routingCorpus';

const live = process.env.AW_LIVE_ASSESSOR === '1';
/** How many completions run at once. Small: this is a subscription, not a batch API. */
const PARALLEL = 2;

/** A completion that remembers the last answer it returned, so the run can record it. */
class Recorder implements StructuredCompletion {
  last: { value: unknown; model: string } | undefined;
  failure: string | undefined;
  constructor(private readonly inner: StructuredCompletion) {}
  async complete<T>(req: Parameters<StructuredCompletion['complete']>[0]) {
    const r = await this.inner.complete<T>(req);
    this.last = r.ok ? { value: r.value, model: r.model } : undefined;
    this.failure = r.ok ? undefined : r.reason;
    return r;
  }
}

async function assessLive(
  c: CorpusCard,
): Promise<{ answer?: ModelAnswer; model?: string; failure?: string; assessment: Awaited<ReturnType<Assessor['assess']>> }> {
  const recorder = new Recorder(
    new ClaudeStructuredCompletion({ query: sdkQuery as CompletionQueryFn, binary: () => resolveClaudeBinary('') }),
  );
  const assessor = new Assessor({ completion: recorder, fs: cardFs(c.card.repo), timeoutMs: 120_000 });
  const assessment = await assessor.assess({
    taskId: c.id,
    taskRevision: 1,
    task: cardTask(c),
    repoRoot: CARD_ROOT,
    policy: cardPolicy(c.card.repo),
    repoPolicyVersion: 'corpus',
  });
  return {
    answer: recorder.last?.value as ModelAnswer | undefined,
    model: recorder.last?.model,
    failure: recorder.failure ?? (recorder.last ? undefined : 'threw'),
    assessment,
  };
}

describe.skipIf(!live)('routing corpus: live assessor evaluation', () => {
  it('scores the real assessor against the labels and records its answers', async () => {
    const corpus = loadCorpus();
    const results = new Map<string, Awaited<ReturnType<typeof assessLive>>>();
    const queue = [...corpus];
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        for (let c = queue.shift(); c; c = queue.shift()) results.set(c.id, await assessLive(c));
      }),
    );

    const agreement = emptyAgreement();
    const recording: Recording = {
      assessorVersion: ASSESSOR_VERSION,
      model: '',
      recordedAt: new Date().toISOString().slice(0, 10),
      agreement,
      failed: {},
      answers: {},
    };
    let within = 0;
    let egregious = 0;
    for (const c of corpus) {
      const r = results.get(c.id)!;
      if (!r.answer) {
        recording.failed[c.id] = r.failure ?? 'unknown';
        continue;
      }
      recording.model ||= r.model ?? '';
      recording.answers[c.id] = { cardHash: cardHash(c), answer: r.answer };
      // A `TaskAssessment` is the combined assessment plus its bookkeeping.
      const combined = r.assessment;
      addAgreement(agreement, c.labels, combined);
      if (corpusRouter) {
        const v = evaluateCard(c, combined, corpusRouter);
        if (v.misses.length === 0) within++;
        if (v.egregious.length > 0) egregious++;
      }
    }

    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    fs.writeFileSync(recordingPath(ASSESSOR_VERSION), `${JSON.stringify(recording, null, 2)}\n`);

    const failed = Object.entries(recording.failed);
    const lines = [
      `assessor ${ASSESSOR_VERSION} on ${recording.model}`,
      formatAgreement(agreement),
      `failed completions: ${failed.length}${failed.length ? ` (${failed.map(([id, why]) => `${id}: ${why}`).join(', ')})` : ''}`,
    ];
    if (corpusRouter) lines.push(`routes inside expectations: ${within}/${agreement.cards}`, `egregious misroutes: ${egregious}`);
    console.log(lines.join('\n'));

    expect(failed.length, 'completions that failed').toBeLessThan(corpus.length);
    expect(egregious, 'egregious misroutes from real assessments').toBe(0);
  }, 900_000);
});
