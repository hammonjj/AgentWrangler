/**
 * Unified-patch arithmetic, kept away from `vscode` so it can be tested without
 * an extension host — the same reason `markdown.ts` lives here. The diff editor
 * that consumes it is in `ui/conversation/diffView.ts`.
 */

/**
 * Split a unified patch into the two sides it describes.
 *
 * Hunks cover disjoint regions of the file, so their `@@` headers are kept and
 * emitted into *both* sides. They then read as unchanged context, which both
 * separates the regions visibly and stops the diff editor trying to align the
 * end of one hunk with the start of the next.
 */
export function splitUnifiedPatch(patch: string): { before: string; after: string } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) {
      before.push(line);
      after.push(line);
      continue;
    }
    const body = line.slice(1);
    // A `\` line is diff's "no newline at end of file" marker, not content.
    if (line.startsWith('\\')) continue;
    if (line.startsWith('-')) before.push(body);
    else if (line.startsWith('+')) after.push(body);
    else {
      // Context, including the blank lines a patch writes as a bare space —
      // and truly empty lines, which some producers emit instead.
      before.push(body);
      after.push(body);
    }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/** One side of a side-by-side row: its line number in that version of the file, when the patch says, and its text. */
export interface DiffCell {
  n?: number;
  text: string;
  change: 'ctx' | 'del' | 'add';
}

/** A row of the side-by-side view: a full-width line (a header or hunk marker), or a left and a right cell. */
export type SideBySideRow =
  | { kind: 'meta' | 'hunk'; text: string }
  | { kind: 'line'; left?: DiffCell; right?: DiffCell };

/**
 * Lay a unified patch out as rows with a left (before) and right (after) cell.
 * A run of removed lines is paired with the run of added lines that follows it,
 * so a changed line sits level with what replaced it; the longer run leaves
 * blank cells opposite. Line numbers come from each `@@ -a,b +c,d @@` header.
 */
export function sideBySideRows(patch: string): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let oldN: number | undefined;
  let newN: number | undefined;
  let dels: DiffCell[] = [];
  let adds: DiffCell[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) rows.push({ kind: 'line', left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  const bump = (n: number | undefined) => (n === undefined ? undefined : n + 1);
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    // Before the first hunk a line is a file header (`diff `, `index `, `---`, `+++`), not content.
    if (oldN === undefined && newN === undefined) {
      if (line) rows.push({ kind: 'meta', text: line });
      continue;
    }
    if (line.startsWith('\\')) continue; // "no newline at end of file"
    const body = line.slice(1);
    if (line.startsWith('-')) {
      dels.push({ n: oldN, text: body, change: 'del' });
      oldN = bump(oldN);
    } else if (line.startsWith('+')) {
      adds.push({ n: newN, text: body, change: 'add' });
      newN = bump(newN);
    } else {
      flush();
      rows.push({ kind: 'line', left: { n: oldN, text: body, change: 'ctx' }, right: { n: newN, text: body, change: 'ctx' } });
      oldN = bump(oldN);
      newN = bump(newN);
    }
  }
  flush();
  // A patch's trailing newline leaves one empty context row.
  const last = rows[rows.length - 1];
  if (last?.kind === 'line' && last.left?.change === 'ctx' && last.left.text === '' && last.right?.text === '' && patch.endsWith('\n')) rows.pop();
  return rows;
}

/** The narrowest a container can be and still show two columns of code. Below it the unified view is the one offered. */
export const SIDE_BY_SIDE_MIN_PX = 640;
