/**
 * The codec's real cost, on real time (#194): what sealing and opening a batch of each size takes
 * on this machine. The virtual-time model leaves crypto out so a CI machine's speed cannot move a
 * threshold; this puts it back beside the model's numbers, as CPU, where it belongs.
 */
import { performance } from 'node:perf_hooks';
import { RelayCodec, connectionTopic, importRelayKey, newRelayKey, type RelayItem } from '../../src/shared/relay';

export interface CodecCost {
  /** Items' JSON size, KB. */
  kb: number;
  parts: number;
  sealMs: number;
  openMs: number;
}

const UID = '00000000-0000-4000-8000-000000000001';

function words(chars: number): string {
  const pool = 'the quick brown fox jumps over a lazy dog while reading and writing code in a repository'.split(' ');
  let out = '';
  let i = 0;
  while (out.length < chars) out += `${pool[(i++ * 7919) % pool.length]}${(i * 104729) % 97} `;
  return out;
}

/** Median of a few runs for each payload size. */
export async function measureCodec(sizesKb: readonly number[] = [4, 85, 360, 1024], runs = 5): Promise<CodecCost[]> {
  const key = await importRelayKey(newRelayKey());
  const topic = connectionTopic(UID, 'aaaaaaaaaaaaaaaaaaaaaaaa');
  const costs: CodecCost[] = [];
  for (const kb of sizesKb) {
    const items: RelayItem[] = [{ k: 'data', line: words(kb * 1024) }];
    const seals: number[] = [];
    const opens: number[] = [];
    let parts = 0;
    for (let r = 0; r < runs; r++) {
      const daemon = new RelayCodec(key, 'dev1', topic, 'd2b');
      const browser = new RelayCodec(key, 'dev1', topic, 'b2d');
      const t0 = performance.now();
      const sealed = await daemon.seal(items);
      const t1 = performance.now();
      for (const p of sealed) await browser.open(p);
      const t2 = performance.now();
      seals.push(t1 - t0);
      opens.push(t2 - t1);
      parts = sealed.length;
    }
    const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    costs.push({ kb, parts, sealMs: Math.round(median(seals) * 10) / 10, openMs: Math.round(median(opens) * 10) / 10 });
  }
  return costs;
}
