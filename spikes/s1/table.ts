/**
 * Spike S1 (#5): one row per run, from every result.json under the runs dir.
 *   node spikes/s1/table.ts
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const runs = '/tmp/aw-spike-s1/runs';
type O = { role: string; diedAt?: number; orphanAt?: number };
console.log('| run | holder gone | claude exit | orphan (ppid 1) | shells | tx lines added after hit | tx intact | sessions json during → after | hooks |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const d of fs.readdirSync(runs).sort()) {
  const f = path.join(runs, d, 'result.json');
  if (!fs.existsSync(f)) continue;
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  const obs = r.observe as O[];
  const holder = obs.find((o) => o.role === 'holder');
  const claude = obs.find((o) => o.role === 'claude');
  const shells = obs.filter((o) => o.role !== 'holder' && o.role !== 'claude');
  const shellTxt = shells.length ? `${shells[0].role} died +${shells[0].diedAt ?? 'ALIVE'}` : '-';
  const a = r.transcriptAfter, b = r.transcriptBefore;
  const intact = a.exists ? (a.badLines === 0 && a.endsWithNewline ? 'yes' : `NO (${a.badLines} bad)`) : 'none';
  const samples = (r.sessionSamples ?? []).map((s: { ms: number; exists: boolean }) => `${Math.round(s.ms / 1000)}s:${s.exists ? 'Y' : 'N'}`).join(' ');
  console.log(`| ${d.replace(/^\d+-/, '')}${r.error ? ' (' + r.error + ')' : ''} | +${holder?.diedAt ?? '?'} | ${claude?.diedAt !== undefined ? '+' + claude.diedAt : 'ALIVE'}${r.sweptAt ? ` (swept @+${r.sweptAt})` : ''} | ${claude?.orphanAt !== undefined ? 'yes @+' + claude.orphanAt : 'no'} | ${shellTxt} | ${a.exists && b.exists ? a.lines - b.lines : '?'} | ${intact} | ${samples || '-'} → ${r.sessionFileAfterExists ? 'PRESENT' : 'removed'} | ${(r.hookEvents as string[]).join(' ')} |`);
}
