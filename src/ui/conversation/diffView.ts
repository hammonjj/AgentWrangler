import * as path from 'node:path';
import * as vscode from 'vscode';
import { splitUnifiedPatch } from '../../shared/diff';
import type { DiffViewer } from './diffViewer';

/**
 * Open an edit's diff in VSCode's own diff editor.
 *
 * The tool card renders the patch as a +/- block, which is fine for a glance
 * and poor for reading: no syntax highlighting, no side-by-side, no way to jump
 * between hunks. The real editor gives all three for the cost of two virtual
 * documents.
 *
 * Both sides are reconstructed from the patch rather than read off disk. A
 * transcript can be weeks old and the file changed many times since, so "the
 * current file" is not the other half of this edit — the patch is the only
 * record of what the edit actually did.
 */

const SCHEME = 'agent-wrangler-diff';

/**
 * Serves the two sides. Contents are held per-URI and dropped when the pane
 * that opened them goes away; a diff tab left open past that keeps rendering
 * the text VSCode already has.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable, DiffViewer {
  private contents = new Map<string, string>();
  private seq = 0;
  private sub: vscode.Disposable;

  constructor() {
    this.sub = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.contents.clear();
    this.sub.dispose();
  }

  /**
   * Show `patch` as a diff titled after `file`.
   *
   * The URI keeps the file's real basename in its last segment so the editor
   * infers the language from the extension and the tab says something useful;
   * a counter in the segment above keeps two views of the same file apart.
   */
  async open(file: string, patch: string): Promise<void> {
    const { before, after } = splitUnifiedPatch(patch);
    const name = path.basename(file) || 'file';
    const id = ++this.seq;
    const left = vscode.Uri.parse(`${SCHEME}:/${id}/before/${name}`);
    const right = vscode.Uri.parse(`${SCHEME}:/${id}/after/${name}`);
    this.contents.set(left.toString(), before);
    this.contents.set(right.toString(), after);
    // "changed region", not the file: only the hunks are here, and saying so
    // in the tab is cheaper than someone wondering where the rest went.
    await vscode.commands.executeCommand('vscode.diff', left, right, `${name} — changed region`, {
      preview: true,
    } satisfies vscode.TextDocumentShowOptions);
  }
}
