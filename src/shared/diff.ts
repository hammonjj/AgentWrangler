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
