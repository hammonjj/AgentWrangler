import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The webview CSP has no `'unsafe-inline'` in `style-src`, so a `style="..."`
 * attribute in HTML a webview builds is dropped — silently, because a blocked
 * style is a console violation and not an error. It cost a day once: the
 * dragged column widths were written as inline styles, never reached the DOM,
 * and `table-layout: fixed` split the table equally instead, so every drag
 * looked like it resized every column at once.
 *
 * Lengths that are data belong in `data-w` / `data-top`, which the webview
 * paints into the CSSOM after rendering. This test is the reminder.
 */
const SRC = path.join(__dirname, '..', 'src');

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() && p.endsWith('.ts') ? [p] : [];
  });
}

/** Comments are prose, and prose is allowed to quote the thing it warns about. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '');
}

describe('webview markup', () => {
  it('never carries an inline style attribute', () => {
    const offenders = filesUnder(path.join(SRC, 'webview'))
      .filter((f) => /\bstyle\s*=\s*["']/.test(code(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  /**
   * The other silent-styling trap: `el.hidden = true` is a user-agent rule, and
   * any author `display` beats it regardless of specificity. `#composerRead {
   * display: flex }` was enough to keep the read-only note ("This session runs
   * in another VSCode window…") on screen above the composer's dropdowns in a
   * pane that had since become typeable.
   */
  it('makes the hidden attribute win over every stylesheet', () => {
    const sheets = fs
      .readdirSync(path.join(SRC, 'webview'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .flatMap((e) =>
        fs
          .readdirSync(path.join(SRC, 'webview', e.name))
          .filter((f) => f.endsWith('.css'))
          .map((f) => path.join(SRC, 'webview', e.name, f)),
      );
    expect(sheets.length).toBeGreaterThan(0);
    for (const sheet of sheets) {
      const css = fs.readFileSync(sheet, 'utf8');
      expect(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css), path.relative(SRC, sheet)).toBe(true);
    }
  });

  it('has a CSP that would drop one', () => {
    const html = fs.readFileSync(path.join(SRC, 'ui', 'html.ts'), 'utf8');
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
    expect(csp).toBeDefined();
    expect(csp).toContain('style-src');
    expect(csp).not.toContain('unsafe-inline');
  });
});
