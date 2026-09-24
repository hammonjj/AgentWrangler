/**
 * Spike S1 (#5): print the shape of a run's transcript (types, timestamps,
 * content kinds, lengths; never the text itself) relative to the kill time.
 *   node spikes/s1/tx.ts <run dir> [...]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

for (const dir of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  const ev = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const killAt = r.holderEvents.find((e: { kind: string }) => e.kind === 'clean_exit')?.at
    ?? (ev.find((e: { kind: string }) => e.kind === 'READY')?.at ?? 0) + 300;
  console.log(`== ${path.basename(dir)}  (t relative to ~kill; claude died at +${r.observe.find((o: { role: string }) => o.role === 'claude')?.diedAt ?? 'ALIVE'} ms)`);
  console.log('   holder:', r.holderEvents.map((e: { kind: string; subtype?: string; sinceKill: number }) => `${e.kind}${e.subtype ? '/' + e.subtype : ''}@${e.sinceKill}`).join(' '));
  if (!r.transcriptPath) continue;
  for (const l of fs.readFileSync(r.transcriptPath, 'utf8').split('\n').filter(Boolean)) {
    const j = JSON.parse(l);
    if (j.type === 'attachment' || j.type === 'queue-operation') continue;
    const t = j.timestamp ? Date.parse(j.timestamp) - killAt : '';
    const c = j.message?.content;
    const kinds = typeof c === 'string' ? `str(${c.length})` : Array.isArray(c) ? c.map((x: { type: string; name?: string; text?: string; is_error?: boolean; content?: unknown }) => `${x.type}${x.name ? ':' + x.name : ''}${x.text ? '(' + x.text.length + ')' : ''}${x.is_error ? '!err' : ''}${x.type === 'tool_result' ? '[' + String(typeof x.content === 'string' ? x.content : JSON.stringify(x.content)).slice(0, 90) + ']' : ''}`).join(',') : '';
    console.log(`   ${String(t).padStart(7)} ${j.type}${j.subtype ? '/' + j.subtype : ''} ${kinds} ${j.message?.stop_reason ?? ''}${j.toolUseResult && typeof j.toolUseResult === 'object' && 'interrupted' in j.toolUseResult ? ' interrupted=' + j.toolUseResult.interrupted : ''}`);
  }
}
