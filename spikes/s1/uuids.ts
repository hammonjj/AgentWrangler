/**
 * Spike S1 (#5): do SDK message uuids match transcript entries? Throwaway.
 *
 *   node spikes/s1/uuids.ts            (scans every run under /tmp/aw-spike-s1/runs)
 *
 * For each run, joins the uuids the holder saw on SDK messages against the
 * `uuid` fields of the session's transcript, by SDK message type.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const runs = path.join('/tmp/aw-spike-s1/runs');
const tally = new Map<string, { seen: number; inTranscript: number; noUuid: number }>();
let transcriptOnly = new Map<string, number>();
for (const d of fs.readdirSync(runs)) {
  const rf = path.join(runs, d, 'result.json');
  if (!fs.existsSync(rf)) continue;
  const r = JSON.parse(fs.readFileSync(rf, 'utf8')) as { transcriptPath?: string };
  if (!r.transcriptPath || !fs.existsSync(r.transcriptPath)) continue;
  const tx = fs.readFileSync(r.transcriptPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { uuid?: string; type: string });
  const txUuids = new Map(tx.filter((t) => t.uuid).map((t) => [t.uuid!, t.type]));
  const sdkUuids = new Set<string>();
  for (const l of fs.readFileSync(path.join(runs, d, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(l) as { kind: string; type?: string; subtype?: string; uuid?: string };
    if (e.kind === 'send' && e.uuid) {
      console.log(`  send uuid ${d}: ${txUuids.has(e.uuid) ? 'IS' : 'is NOT'} the transcript user entry's uuid`);
      sdkUuids.add(e.uuid);
    }
    if (e.kind !== 'sdk' && e.kind !== 'sdk_stream') continue;
    const key = e.kind === 'sdk_stream' ? 'stream_event' : `${e.type}${e.subtype ? '/' + e.subtype : ''}`;
    const t = tally.get(key) ?? { seen: 0, inTranscript: 0, noUuid: 0 };
    t.seen++;
    if (!e.uuid) t.noUuid++;
    else {
      sdkUuids.add(e.uuid);
      if (txUuids.has(e.uuid)) t.inTranscript++;
      else if (e.type === 'assistant' || e.type === 'user') console.log(`  miss: ${d} ${e.type} ${JSON.stringify((e as { content?: unknown }).content ?? '')}`);
    }
    tally.set(key, t);
  }
  for (const [u, type] of txUuids) if (!sdkUuids.has(u)) transcriptOnly.set(type, (transcriptOnly.get(type) ?? 0) + 1);
}
console.log('SDK message type → seen / uuid found in transcript / no uuid');
for (const [k, v] of [...tally].sort()) console.log(`  ${k.padEnd(34)} ${v.seen} / ${v.inTranscript} / ${v.noUuid}`);
console.log('transcript entries with a uuid never seen on the SDK stream, by type:');
for (const [k, v] of transcriptOnly) console.log(`  ${k.padEnd(34)} ${v}`);
