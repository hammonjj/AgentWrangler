/**
 * The records automatic routing's gate and the shadow comparison report are
 * computed from (§27.3, #42): every `routing` and `attempt` record in the
 * telemetry log, read once at start and then added as they are written.
 * Metadata only, like the log itself. The computing is
 * `shared/orchestration/autoRouting.ts`'s; this only holds the records.
 */
import { isEvidenceRecord, type EvidenceRecord } from '../../shared/orchestration/autoRouting';
import { TelemetryIndex } from './telemetryIndex';

export class RoutingEvidenceIndex extends TelemetryIndex<EvidenceRecord> {
  constructor() {
    super(isEvidenceRecord, ['routing', 'attempt']);
  }
}
