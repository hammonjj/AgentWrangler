/**
 * Showing an edit's two sides properly, wherever "properly" happens to be.
 *
 * In VSCode that is the real diff editor, which `DiffContentProvider` reaches
 * through `vscode.diff` and two virtual documents. There is no equivalent in a
 * plain desktop window short of bundling Monaco, so this is an interface and
 * the capability is allowed to be absent: a host that cannot show a diff says
 * so, and the tool card's inline +/- block stays the whole story.
 */
export interface DiffViewer {
  /** Show `patch` as a diff titled after `file`. */
  open(file: string, patch: string): Promise<void>;
}
