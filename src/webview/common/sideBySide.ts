/**
 * The side-by-side diff (#146), drawn from a unified patch as a table: line
 * number and text for the version before on the left, after on the right.
 * Classes only (the page's CSP forbids inline styles); `aw-sbs-*` in
 * `theme/vscodeTokens.css`. Shared by the file viewer (`hostView.ts`) and the
 * conversation's edit cards, which is why it lives in `common/`.
 */
import { sideBySideRows, type DiffCell } from '../../shared/diff';

function cell(tag: 'td', cls: string, text: string): HTMLTableCellElement {
  const c = document.createElement(tag);
  c.className = cls;
  c.textContent = text;
  return c;
}

function side(row: HTMLTableRowElement, c: DiffCell | undefined): void {
  const kind = c ? `aw-sbs-${c.change}` : 'aw-sbs-empty';
  row.appendChild(cell('td', `aw-sbs-n ${kind}`, c?.n === undefined ? '' : String(c.n)));
  row.appendChild(cell('td', `aw-sbs-t ${kind}`, c ? c.text : ''));
}

/** Replace `into`'s children with the side-by-side view of `patch`. */
export function renderSideBySide(into: HTMLElement, patch: string): void {
  const table = document.createElement('table');
  table.className = 'aw-sbs';
  const body = document.createElement('tbody');
  for (const r of sideBySideRows(patch)) {
    const tr = document.createElement('tr');
    if (r.kind === 'line') {
      side(tr, r.left);
      side(tr, r.right);
    } else {
      const td = cell('td', r.kind === 'hunk' ? 'aw-sbs-hunk' : 'aw-sbs-meta', r.text);
      td.colSpan = 4;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  into.replaceChildren(table);
}
