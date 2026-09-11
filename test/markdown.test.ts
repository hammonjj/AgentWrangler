import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/shared/markdown';

/**
 * The conversation pane puts this output straight into `innerHTML`, and the
 * text it renders is whatever a model said or a tool printed. `html: false` is
 * the only thing standing between those and script execution, so it gets a test
 * of its own rather than a comment.
 */
describe('renderMarkdown escaping', () => {
  it('escapes a script tag instead of parsing it', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes event handlers smuggled in as markup', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes markup inside a fenced code block', () => {
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<pre>');
  });

  it('neutralises a javascript: link', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
  });

  it('still renders the markdown a reply actually uses', () => {
    const html = renderMarkdown('**bold** and `code`\n\n- one\n- two');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<li>one</li>');
  });

  it('treats a single newline as a line break, the way chat text reads', () => {
    expect(renderMarkdown('one\ntwo')).toContain('<br>');
  });
});
