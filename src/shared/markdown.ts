/**
 * Markdown for conversation text.
 *
 * `html: false` is the security boundary: raw markup in a reply — a model
 * quoting HTML, a tool printing a `<script>` tag — is escaped rather than
 * parsed, so nothing a conversation contains can execute in the webview. Keep
 * it that way; the pane has no sanitizer behind it.
 *
 * Lives in `shared` so the escaping can be tested without a DOM.
 */
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({
  html: false,
  // A bare URL in a tool result should still be clickable.
  linkify: true,
  // Chat text uses single newlines as line breaks; markdown's "two spaces"
  // rule would swallow most of them.
  breaks: true,
});

export function renderMarkdown(text: string): string {
  return md.render(text);
}
