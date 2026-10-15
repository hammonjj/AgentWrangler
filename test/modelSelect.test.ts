import { describe, expect, it } from 'vitest';
import { modelOptionsHtml } from '../src/webview/dashboard/modelSelect';
import type { ModelChoice } from '../src/shared/conversation';

const MODELS: ModelChoice[] = [
  { provider: 'anthropic', value: 'default', label: 'Default (Sonnet 4.5)' },
  { provider: 'anthropic', value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' }, // an older catalog with no provider: Anthropic
  { provider: 'openai', value: 'gpt-5', label: 'GPT-5' },
];

const values = (html: string) => [...html.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);

describe('the model dropdown (#183)', () => {
  it("offers the harness's models, Default first and labelled with what it resolves to", () => {
    const html = modelOptionsHtml(MODELS, 'claude', 'opus');
    expect(values(html)).toEqual(['', 'opus', 'haiku']);
    expect(html).toContain('>Default (Sonnet 4.5)<');
    expect(html).toContain('<option value="opus" selected>');
    expect(values(modelOptionsHtml(MODELS, 'codex', ''))).toEqual(['', 'gpt-5']);
  });

  it('groups both harnesses when none is fixed', () => {
    const html = modelOptionsHtml(MODELS, undefined, '', 'launcher’s');
    expect(html).toContain('<optgroup label="Claude">');
    expect(html).toContain('<optgroup label="Codex">');
    expect(html).toContain('>launcher’s<');
  });

  it('keeps a saved model the catalog does not list, so editing never drops it', () => {
    const html = modelOptionsHtml([], 'claude', 'claude-opus-4-1');
    expect(values(html)).toEqual(['', 'claude-opus-4-1']);
    expect(html).toContain('claude-opus-4-1 (not in the list)');
  });

  it('escapes what the CLI reported', () => {
    expect(modelOptionsHtml([{ value: 'x"y', label: '<b>' }], 'claude', '')).not.toContain('<b>');
  });
});
