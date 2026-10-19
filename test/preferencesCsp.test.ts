import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Preferences is built from DOM calls, and its CSP drops inline styles and
 * inline scripts without an error. So nothing under `src/webview/preferences`
 * may write a style at all: not an attribute, not `.style`, not `cssText`, and
 * no `<script>` it builds. State is a class or an ARIA attribute instead.
 */
const DIR = path.join(__dirname, '..', 'src', 'webview', 'preferences');

function sources(): { file: string; code: string }[] {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({
      file: f,
      // Comments are prose, and prose may name the thing it warns about.
      code: fs
        .readFileSync(path.join(DIR, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|\s)\/\/.*$/gm, ''),
    }));
}

const RULES: [string, RegExp][] = [
  ['a style attribute in markup', /\bstyle\s*=\s*["'`]/],
  ["setAttribute('style', …)", /setAttribute\(\s*["'`]style["'`]/],
  ['a .style write or read', /\.style\b/],
  ['cssText', /cssText/],
  ['insertRule', /insertRule/],
  ['a <script> element', /createElement\(\s*["'`]script["'`]|<script/i],
  ['innerHTML', /\.innerHTML\b|insertAdjacentHTML/],
  ['an inline event handler attribute', /setAttribute\(\s*["'`]on[a-z]+["'`]/],
];

describe('Preferences webview under its CSP', () => {
  it('has source files to check', () => {
    expect(sources().length).toBeGreaterThan(3);
  });

  for (const [what, pattern] of RULES) {
    it(`never uses ${what}`, () => {
      const offenders = sources()
        .filter((s) => pattern.test(s.code))
        .map((s) => s.file);
      expect(offenders).toEqual([]);
    });
  }

  it('imports only shared code and its own files', () => {
    for (const s of sources()) {
      const specs = [...s.code.matchAll(/from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
      for (const spec of specs) {
        const ok = spec.startsWith('./') || spec.startsWith('../../shared/') || spec.startsWith('../common/');
        expect(ok, `${s.file} imports ${spec}`).toBe(true);
      }
    }
  });

  it('gives the report real tables with header cells, and the routing mode a radio group', () => {
    const report = fs.readFileSync(path.join(DIR, 'orchReport.ts'), 'utf8');
    expect(report).toMatch(/el\('table'/);
    expect(report).toMatch(/el\('th'/);
    expect(report).toMatch(/scope = 'col'/);
    const routing = fs.readFileSync(path.join(DIR, 'orchRouting.ts'), 'utf8');
    expect(routing).toMatch(/'role', 'radiogroup'/);
    expect(routing).toMatch(/'role', 'radio'/);
    const endpoints = fs.readFileSync(path.join(DIR, 'orchEndpoints.ts'), 'utf8');
    expect(endpoints).toMatch(/switchButton\(/);
  });

  it('sizes the Orchestration section off its container, not the viewport', () => {
    const css = fs.readFileSync(path.join(DIR, 'orchestration.css'), 'utf8');
    expect(css).toMatch(/container:\s*aw-orch\s*\/\s*inline-size/);
    expect(css).toMatch(/@container aw-orch/);
    expect(css).not.toMatch(/@media[^{]*width/);
    expect(css).not.toMatch(/\bvw\b/);
  });
});
