/**
 * Reading and writing host manifests (`run/<hostId>.json`) and the files
 * beside them. Shared by the host (the only writer of its manifest) and the
 * core (which reads them, and removes them once a host is gone).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { HostManifest } from '../../shared/sessionProtocol';

/** Write atomically (temp file, then rename) with mode 0600, so a reader never sees half a manifest. */
export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** A v1 manifest this build understands. */
export function readManifest(file: string): HostManifest | undefined {
  const read = readAnyManifest(file);
  return read?.known ? read.manifest : undefined;
}

/**
 * Any manifest, including one from a version this build does not know. Every
 * version keeps `v`, `hostId`, `hostPid`, `hostStartTime`, `sessionId` and
 * `protocol` (see `HostManifest`), so even a foreign one says which session a
 * live host holds, and that session must not be taken for ownerless.
 */
export function readAnyManifest(file: string): { manifest: HostManifest; known: boolean } | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<HostManifest> & { v?: unknown };
    if (typeof raw?.hostId !== 'string' || typeof raw.hostPid !== 'number' || typeof raw.v !== 'number') return undefined;
    const known = raw.v === 1 && typeof raw.socketPath === 'string';
    return { manifest: raw as HostManifest, known };
  } catch {
    return undefined;
  }
}

/** Every readable manifest in `dir`, known versions only unless `includeForeign`. */
export function readManifests(dir: string, includeForeign = false): { file: string; manifest: HostManifest; known: boolean }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: { file: string; manifest: HostManifest; known: boolean }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const read = readAnyManifest(file);
    if (read && (read.known || includeForeign)) out.push({ file, ...read });
  }
  return out;
}

/** The manifest, its token and its socket: everything a gone host leaves behind. */
export function removeHostFiles(runDir: string, manifest: HostManifest): void {
  for (const file of [
    path.join(runDir, `${manifest.hostId}.json`),
    path.join(runDir, `${manifest.hostId}.token`),
    manifest.socketPath,
  ]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // gone already
    }
  }
}
