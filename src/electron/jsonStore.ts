/**
 * `HostStorage` and `HostSettings` over a JSON file.
 *
 * VSCode supplies `globalState`, `workspaceState` and a settings UI; a desktop
 * app has to keep its own. Both of the interfaces those satisfy were already
 * structural — `ArchiveService`, `RunnerRegistry` and the rest take a
 * `{get, update}` rather than a `vscode.Memento` — so this is the whole of the
 * replacement.
 *
 * Writes are synchronous and whole-file. The documents are a few kilobytes of
 * pins, nicknames and column widths written when a human clicks something, so
 * the cost is nothing and the alternative — a debounced async write — can lose
 * the last change to a quit. Written to a sibling temp file and renamed, so a
 * crash mid-write leaves the previous document rather than half of the new one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Emitter, type Disposable } from '../core/events';
import type { HostSettings, HostStorage } from '../host/hostServices';

type Document = Record<string, unknown>;

function read(file: string): Document {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Document) : {};
  } catch {
    // Absent is the normal first run; corrupt is rare and recovering as empty
    // beats refusing to start over a preferences file.
    return {};
  }
}

function write(file: string, doc: Document): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class JsonStore implements HostStorage {
  private doc: Document;

  constructor(private file: string) {
    this.doc = read(file);
  }

  get<T>(key: string, defaultValue: T): T {
    const v = this.doc[key];
    return v === undefined ? defaultValue : (v as T);
  }

  update(key: string, value: unknown): unknown {
    if (value === undefined) delete this.doc[key];
    else this.doc[key] = value;
    write(this.file, this.doc);
    return undefined;
  }
}

/**
 * The same file, plus a change event and `undefined`-means-default.
 *
 * Keys are the dotted names the extension uses without their `agentWrangler.`
 * prefix — `runner.model`, `autoPause.percent` — and they are stored flat, with
 * the dots in the key rather than as nested objects. That keeps this file
 * readable next to `package.json`'s `contributes.configuration`, which is the
 * document that actually defines what the settings are.
 */
export class JsonSettings implements HostSettings {
  private doc: Document;
  private emitter = new Emitter<(key: string) => boolean>();

  constructor(private file: string) {
    this.doc = read(file);
  }

  get<T>(key: string, defaultValue: T): T {
    const v = this.doc[key];
    return v === undefined ? defaultValue : (v as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) delete this.doc[key];
    else this.doc[key] = value;
    write(this.file, this.doc);
    this.emitter.fire((k) => k === key);
  }

  onDidChange(listener: (affects: (key: string) => boolean) => void): Disposable {
    return this.emitter.event(listener);
  }

  /** Re-read the file, for a change made outside the app. Fires for everything. */
  reload(): void {
    this.doc = read(this.file);
    this.emitter.fire(() => true);
  }
}
