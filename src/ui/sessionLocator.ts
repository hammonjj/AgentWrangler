import * as vscode from 'vscode';
import { ancestorsOf, readProcessTable, type ProcessTable } from '../core/procTree';
import type { LocationKind } from './openTarget';

export type SessionLocation =
  | { kind: 'terminal'; terminal: vscode.Terminal }
  | { kind: Exclude<LocationKind, 'terminal'> };

/** Snapshot decoration tolerates a table this old; a click reads a fresh one. */
const TABLE_MAX_AGE_MS = 3_000;

/**
 * Finds which surface in this window, if any, hosts a session's process, by
 * walking its ancestors in the process table:
 *
 *  - this extension host among them → a Claude Code panel in this window;
 *  - one of this window's terminal shells among them → that terminal;
 *  - otherwise, sharing an ancestor with us (the VSCode main process) → some
 *    other window of this same VSCode app; sharing nothing → external.
 *
 * Terminal shell pids come from `Terminal.processId`, which is a promise; the
 * answers are cached per terminal object, so steady state costs nothing.
 */
export class SessionLocator {
  private table?: { readAtMs: number; map: ProcessTable | undefined; pending?: Promise<ProcessTable | undefined> };
  private shellPids = new WeakMap<vscode.Terminal, Promise<number | undefined>>();

  constructor(
    private readonly hostPid: number = process.pid,
    private readonly readTable: () => Promise<ProcessTable | undefined> = readProcessTable,
    private readonly terminals: () => readonly vscode.Terminal[] = () => vscode.window.terminals,
  ) {}

  async locate(pid: number | undefined, opts: { fresh?: boolean } = {}): Promise<SessionLocation> {
    if (pid === undefined) return { kind: 'unavailable' };
    const table = await this.processTable(opts.fresh ? 0 : TABLE_MAX_AGE_MS);
    if (!table) return { kind: 'unavailable' };
    return this.locateIn(pid, table, await this.terminalsByShellPid());
  }

  /** One table read and one terminal lookup for a whole snapshot. */
  async locateMany(pids: Iterable<number>): Promise<Map<number, LocationKind>> {
    const out = new Map<number, LocationKind>();
    const table = await this.processTable(TABLE_MAX_AGE_MS);
    if (!table) {
      for (const pid of pids) out.set(pid, 'unavailable');
      return out;
    }
    const shells = await this.terminalsByShellPid();
    for (const pid of pids) out.set(pid, this.locateIn(pid, table, shells).kind);
    return out;
  }

  private locateIn(pid: number, table: ProcessTable, shells: Map<number, vscode.Terminal>): SessionLocation {
    if (!table.has(pid)) return { kind: 'dead' };
    const ancestors = ancestorsOf(pid, table);
    // Terminals first: a terminal's shell is never under the extension host,
    // but checking in this order keeps the answer right even if that changed.
    for (const a of ancestors) {
      const terminal = shells.get(a);
      if (terminal) return { kind: 'terminal', terminal };
    }
    if (ancestors.includes(this.hostPid)) return { kind: 'panel' };
    const ours = new Set(ancestorsOf(this.hostPid, table));
    return ancestors.some((a) => ours.has(a)) ? { kind: 'other-window' } : { kind: 'external' };
  }

  private processTable(maxAgeMs: number): Promise<ProcessTable | undefined> {
    const now = Date.now();
    if (this.table?.pending) return this.table.pending;
    if (this.table && now - this.table.readAtMs <= maxAgeMs) return Promise.resolve(this.table.map);
    const pending = this.readTable().then((map) => {
      this.table = { readAtMs: Date.now(), map };
      return map;
    });
    this.table = { readAtMs: this.table?.readAtMs ?? 0, map: this.table?.map, pending };
    return pending;
  }

  private async terminalsByShellPid(): Promise<Map<number, vscode.Terminal>> {
    const list = this.terminals();
    const pids = await Promise.all(
      list.map((t) => {
        let p = this.shellPids.get(t);
        if (!p) {
          p = Promise.resolve(t.processId).catch(() => undefined);
          this.shellPids.set(t, p);
        }
        return p;
      }),
    );
    const out = new Map<number, vscode.Terminal>();
    pids.forEach((pid, i) => {
      if (pid !== undefined) out.set(pid, list[i]);
    });
    return out;
  }
}
