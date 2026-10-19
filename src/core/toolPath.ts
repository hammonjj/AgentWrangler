import * as path from 'node:path';

/** Finder launches the app without the Homebrew paths used by interactive shells. */
export function toolPath(currentPath: string | undefined, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin') return currentPath ?? '';

  const dirs = (currentPath ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs.join(path.delimiter);
}
