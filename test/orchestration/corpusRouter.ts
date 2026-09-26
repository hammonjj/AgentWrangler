/**
 * The router the routing corpus evaluates (#39): an assessment in, a
 * requirement out. This file is the one seam between the corpus and the
 * router (#38), so a change to the router's signature is a change here only.
 *
 * The corpus judges the router's rules, not a mission's caps, so it routes
 * with the default tier list and no caps or preferences.
 */
import { ASSESSOR_VERSION } from '../../src/orchestration/policy/assessment';
import { routeTask } from '../../src/orchestration/policy/router';
import { DEFAULT_TIERS } from '../../src/shared/orchestration/catalog';
import type { CorpusRouter } from './routingCorpus';

export const corpusRouter: CorpusRouter | undefined = (a) =>
  routeTask(
    { id: 'corpus', taskId: 'corpus', taskRevision: 1, inputsHash: 'corpus', assessorVersion: ASSESSOR_VERSION, createdAt: 0, ...a },
    { tiers: DEFAULT_TIERS },
  ).requirement;
