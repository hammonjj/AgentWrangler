/**
 * The model dropdown every form uses (#183): the Agents form, the Jobs form
 * and a mission task's Model pin. The rows are the models the CLIs report
 * (the launcher's catalog), so a model can be picked, never mistyped.
 *
 * The first row is the empty value, meaning "whatever the default is". A saved
 * value the catalog does not list (it has not reported yet, or the model went
 * away) stays as a row of its own, so editing something never drops it
 * silently.
 */
import type { ModelChoice } from '../../shared/conversation';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export type ModelHarness = 'claude' | 'codex';

const SOURCE: Record<ModelHarness, 'anthropic' | 'openai'> = { claude: 'anthropic', codex: 'openai' };
const GROUP: Record<ModelHarness, string> = { claude: 'Claude', codex: 'Codex' };

function rowsFor(models: readonly ModelChoice[], harness: ModelHarness): ModelChoice[] {
  // The CLI's own "default" row is the empty choice already; it is not listed twice.
  return models.filter((m) => (m.provider ?? 'anthropic') === SOURCE[harness] && m.value !== 'default' && m.value !== '');
}

/**
 * `<option>`s for a model `<select>`. `harness`: only that harness's models;
 * absent, both, grouped. `emptyLabel` names what the empty value means
 * ("Default", "launcher’s").
 */
export function modelOptionsHtml(models: readonly ModelChoice[], harness: ModelHarness | undefined, selected: string, emptyLabel = 'Default'): string {
  const opt = (value: string, label: string) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
  const harnesses: ModelHarness[] = harness ? [harness] : ['claude', 'codex'];
  const groups = harnesses.map((h) => ({ h, rows: rowsFor(models, h) }));
  const listed = groups.some((g) => g.rows.some((m) => m.value === selected));
  // "Default (Sonnet 4.5)": the CLI's own default row names what Default resolves to.
  const advertised = harness && emptyLabel === 'Default' ? models.find((m) => (m.provider ?? 'anthropic') === SOURCE[harness] && m.value === 'default')?.label : undefined;
  const out = [opt('', advertised ?? emptyLabel)];
  if (selected && !listed) out.push(opt(selected, `${selected} (not in the list)`));
  for (const { h, rows } of groups) {
    if (rows.length === 0) continue;
    const items = rows.map((m) => opt(m.value, m.label)).join('');
    out.push(harness ? items : `<optgroup label="${GROUP[h]}">${items}</optgroup>`);
  }
  return out.join('');
}
