import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readThreadNames } from '../src/codex/codexProvider';

describe('Codex thread names', () => {
  it('reads the same generated names the Codex app displays and tolerates partial lines', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-codex-index-'));
    const file = path.join(dir, 'session_index.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ id: 'ABC', thread_name: 'Fix transcript formatting' }),
      '{partial',
      JSON.stringify({ id: 'DEF', thread_name: '  Keep undo  ' }),
    ].join('\n'));
    const names = await readThreadNames(file);
    expect(names.get('abc')).toBe('Fix transcript formatting');
    expect(names.get('def')).toBe('Keep undo');
  });
});
