import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MirrorStore, type Mirror } from '../src/remote/mirrorStore';

function mirror(extra: Partial<Mirror> = {}): Mirror {
  return {
    interactionId: 'abc123',
    askKey: 'claude:sess-a#100-1',
    sessionKey: 'claude:sess-a',
    requestId: '100-1',
    ref: { channelId: 'C1', messageId: 'M1' },
    renderHash: 'h1',
    publishedAtMs: Date.now(),
    ...extra,
  };
}

describe('MirrorStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'aw-mirror-'));
    file = path.join(dir, 'mirrors.json');
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('round-trips through the file, so another process can pick it up', async () => {
    const a = new MirrorStore(file);
    await a.load();
    await a.put(mirror());

    const b = new MirrorStore(file);
    await b.load();
    expect(b.get('claude:sess-a#100-1')).toMatchObject({ interactionId: 'abc123', ref: { messageId: 'M1' } });
  });

  it('finds a mirror by the id the remote service sends back', async () => {
    const s = new MirrorStore(file);
    await s.load();
    await s.put(mirror());
    expect(s.byInteractionId('abc123')?.askKey).toBe('claude:sess-a#100-1');
    expect(s.byInteractionId('nope')).toBeUndefined();
  });

  it('replaces rather than duplicating when the same ask is put twice', async () => {
    const s = new MirrorStore(file);
    await s.load();
    await s.put(mirror());
    await s.put(mirror({ renderHash: 'h2' }));
    expect(s.all()).toHaveLength(1);
    expect(s.get('claude:sess-a#100-1')?.renderHash).toBe('h2');
  });

  it('removes', async () => {
    const s = new MirrorStore(file);
    await s.load();
    await s.put(mirror());
    await s.remove('claude:sess-a#100-1');
    expect(s.all()).toHaveLength(0);

    const reloaded = new MirrorStore(file);
    await reloaded.load();
    expect(reloaded.all()).toHaveLength(0);
  });

  it('treats a missing file as an empty map', async () => {
    const s = new MirrorStore(path.join(dir, 'nothing-here.json'));
    await s.load();
    expect(s.all()).toEqual([]);
  });

  it('treats a corrupt file as an empty map rather than throwing', async () => {
    // Losing the map costs some stale buttons; throwing would cost the feature.
    await fsp.writeFile(file, '{ this is not json', 'utf8');
    const s = new MirrorStore(file);
    await s.load();
    expect(s.all()).toEqual([]);
  });

  it('ignores records that are the wrong shape', async () => {
    await fsp.writeFile(
      file,
      JSON.stringify({ version: 1, mirrors: [{ askKey: 'x' }, mirror(), null, 'nope'] }),
      'utf8',
    );
    const s = new MirrorStore(file);
    await s.load();
    expect(s.all()).toHaveLength(1);
  });

  it('drops records too old to have a message left to edit', async () => {
    const old = mirror({ askKey: 'old', publishedAtMs: Date.now() - 3 * 60 * 60 * 1000 });
    await fsp.writeFile(file, JSON.stringify({ version: 1, mirrors: [old, mirror()] }), 'utf8');
    const s = new MirrorStore(file);
    await s.load();
    expect(s.all().map((m) => m.askKey)).toEqual(['claude:sess-a#100-1']);
  });

  it('leaves no temp file behind', async () => {
    const s = new MirrorStore(file);
    await s.load();
    await s.put(mirror());
    expect(await fsp.readdir(dir)).toEqual(['mirrors.json']);
  });

  it('creates the directory if it does not exist yet', async () => {
    const nested = path.join(dir, 'a', 'b', 'mirrors.json');
    const s = new MirrorStore(nested);
    await s.load();
    await s.put(mirror());
    expect(JSON.parse(await fsp.readFile(nested, 'utf8')).mirrors).toHaveLength(1);
  });

  it('only loads once, so a reload cannot discard live state', async () => {
    const s = new MirrorStore(file);
    await s.load();
    await s.put(mirror());
    await s.load(); // a second call must not re-read and drop what is in memory
    expect(s.all()).toHaveLength(1);
  });

  it('keeps the last press, which is what lets a close name who answered', async () => {
    const s = new MirrorStore(file);
    await s.load();
    await s.put(mirror({ lastPress: { actor: { id: 'U1', displayName: 'James' }, choiceId: 'allow', atMs: 5 } }));

    const b = new MirrorStore(file);
    await b.load();
    expect(b.get('claude:sess-a#100-1')?.lastPress).toEqual({
      actor: { id: 'U1', displayName: 'James' },
      choiceId: 'allow',
      atMs: 5,
    });
  });
});
