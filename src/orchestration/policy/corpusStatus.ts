/**
 * What the routing corpus (§27.1, #39) said about this build's router, for
 * automatic routing's gate (§27.3, #42).
 *
 * The corpus runs in `npm test`, not in the app, so the result is carried
 * here as a value. `routingCorpus.test.ts` recomputes it and fails if this is
 * not exactly what the corpus gives now — so a build whose tests passed
 * ships a true statement. A router or assessor version bump without updating
 * this leaves the gate's corpus check unmet (the versions no longer match).
 */
import type { CorpusStatus } from '../../shared/orchestration/autoRouting';

export const CORPUS_STATUS: CorpusStatus = {
  routerVersion: 'rtr-2',
  assessorVersion: 'asm-2',
  cards: 31,
  failing: 0,
  egregious: 0,
};
