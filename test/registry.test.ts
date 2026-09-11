import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRegistry } from '../src/claude/registry';

describe('readRegistry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-registry-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = (pid: number, extra: Record<string, unknown>) =>
    fs.writeFile(
      path.join(dir, `${pid}.json`),
      JSON.stringify({ pid, sessionId: `session-${pid}`, cwd: '/Users/me/proj', startedAt: 1, ...extra }),
    );

  it('drops the derived <project>-<hash> name Claude Code stamps on every session', async () => {
    // The dashboard title line would otherwise read "proj-b4 · <title>" on
    // every row, saying nothing the Project column does not already say.
    await write(1, { name: 'proj-b4', nameSource: 'derived' });
    const [entry] = await readRegistry(dir, () => true);
    expect(entry.name).toBeUndefined();
  });

  it('keeps a name the user chose', async () => {
    await write(2, { name: 'backend-migration', nameSource: 'user' });
    const [entry] = await readRegistry(dir, () => true);
    expect(entry.name).toBe('backend-migration');
  });

  it('keeps a name with no recorded source (older Claude Code versions)', async () => {
    await write(3, { name: 'my-session' });
    const [entry] = await readRegistry(dir, () => true);
    expect(entry.name).toBe('my-session');
  });
});
