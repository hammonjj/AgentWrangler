import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The table and the conversation are one document (the workbench), so an id
 * two panes both declare is one element to `getElementById`, and whichever
 * pane asks second gets the other's. The conversation header's `#usage` did
 * exactly that to the plan-usage strip and overwrote the cards.
 */
const PANES = ['dashboard', 'conversation', 'workbench'];
const ID_RE = /id="([A-Za-z0-9_-]+)"|\.id = '([A-Za-z0-9_-]+)'/g;

function idsOf(pane: string): Set<string> {
  const dir = path.join(__dirname, '..', 'src', 'webview', pane);
  const ids = new Set<string>();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(ID_RE)) ids.add(m[1] ?? m[2]);
  }
  return ids;
}

describe('workbench panes', () => {
  it('declare no element id in common', () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const pane of PANES) {
      for (const id of idsOf(pane)) {
        const other = seen.get(id);
        if (other) clashes.push(`#${id}: ${other} and ${pane}`);
        else seen.set(id, pane);
      }
    }
    expect(clashes).toEqual([]);
  });
});
