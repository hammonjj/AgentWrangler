import type { ProjectDTO } from './model';

/**
 * The launcher dropdown's order: favourites first, by name, then everything
 * else newest-used first with never-used folders last by name.
 *
 * Favourites sort by name rather than by recency because the point of starring
 * one is that it stays where you left it; recency would move it every time a
 * different favourite was used. The full path breaks ties, since two checkouts
 * of one repo share a basename.
 *
 * Shared because both sides apply it: the host on every scan, and the webview
 * the moment a star is clicked, so the row moves without waiting for the round
 * trip. Pure, and it re-sorts from scratch rather than trusting the input
 * order, so a folder that is un-starred drops straight back to its recency slot.
 */
export function orderProjects(list: readonly ProjectDTO[], favourites: ReadonlySet<string>): ProjectDTO[] {
  return list
    .map((p): ProjectDTO => {
      const { favourite: _, ...rest } = p;
      return favourites.has(p.dir) ? { ...rest, favourite: true } : rest;
    })
    .sort((a, b) => {
      if (a.favourite !== b.favourite) return a.favourite ? -1 : 1;
      if (a.favourite) return a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir);
      return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name);
    });
}
