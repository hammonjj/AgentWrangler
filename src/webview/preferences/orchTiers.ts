/**
 * Orchestration → Tiers: the tier list editor.
 *
 * Works on a draft of the list in force; nothing is sent until Save, which is
 * one `setTierList` message (the loader takes a list all or nothing). Each
 * draft row has a stable local id, so a rename is told apart from a delete and
 * an add. The draft is checked with `validateTierList`, the loader's own rules,
 * and the host checks it again before writing. The role line is the router's
 * own position mapping (`tierRoles`).
 */

import type { OrchestrationPrefsView } from '../../shared/preferences';
import { DEFAULT_TIERS, validateTierList, type TierDef } from '../../shared/orchestration/catalog';
import { meterBars } from '../../shared/orchestration/tierBoard';
import { tierRoleLine, tierRoles } from '../../shared/orchestration/tierRoles';
import { draftRenames, isShippedList, tierListImpact } from '../../shared/orchestration/tierListSave';
import { button, el, tabHeader, type Post } from './orchCommon';

interface DraftRow {
  id: number;
  name: string;
  reachableBy: 'route' | 'escalation';
  /** The saved tier this row is; absent for one added here. */
  origin?: string;
  /** The saved tier's old names, so the validator sees a name that collides with one. */
  aliases: string[];
}

interface Draft {
  rows: DraftRow[];
  /** The saved list the draft was made from, to tell a new view from an edit. */
  base: string;
}

let draft: Draft | undefined;
let nextId = 1;
/** After Save: the host's answer, until the next edit. */
let saveStatus: { ok: boolean; text: string } | undefined;
let saving = false;

const listKey = (tiers: readonly TierDef[]) => JSON.stringify(tiers.map((t) => [t.name, t.reachableBy, t.aliases ?? []]));

function fromSaved(tiers: readonly TierDef[]): Draft {
  return {
    rows: tiers.map((t) => ({ id: nextId++, name: t.name, reachableBy: t.reachableBy, origin: t.name, aliases: [...(t.aliases ?? [])] })),
    base: listKey(tiers),
  };
}

function isDirty(d: Draft, saved: readonly TierDef[]): boolean {
  if (d.rows.length !== saved.length) return true;
  return d.rows.some((r, i) => r.origin !== saved[i].name || r.name.trim() !== saved[i].name || r.reachableBy !== saved[i].reachableBy);
}

/** The host answered a save. */
export function onTierListResult(ok: boolean, errors: string[]): void {
  saving = false;
  if (ok) {
    draft = undefined;
    saveStatus = { ok: true, text: 'Saved · applies to tasks that start afterwards' };
  } else saveStatus = { ok: false, text: `Not saved: ${errors.join(' ')}` };
}

function edited(): void {
  saveStatus = undefined;
}

export function renderTiersTab(host: HTMLElement, view: OrchestrationPrefsView, post: Post, redraw: () => void, focus: (key: string) => void): void {
  const saved = view.catalog.tiers;
  // A new list from the host (saved here, or edited in settings.json) replaces an untouched draft.
  if (!draft || (!isDirty(draft, saved) && draft.base !== listKey(saved))) draft = fromSaved(saved);
  const d = draft;
  const dirty = isDirty(d, saved);

  host.appendChild(
    tabHeader(
      'Tiers',
      'Order is the strength ranking, weakest at the top. The router’s rules target the weakest, second and strongest routable tiers by position, whatever you name them.',
    ),
  );

  const validation = validateTierList(d.rows.map((r) => ({ name: r.name, reachableBy: r.reachableBy, aliases: r.aliases })));
  const errorsAt = new Map<number, string[]>();
  if (!validation.ok) for (const e of validation.errors) errorsAt.set(e.index, [...(errorsAt.get(e.index) ?? []), e.message]);
  const invalid = !validation.ok;

  const counts = new Map<string, number>();
  for (const e of view.catalog.entries) if (e.tier) counts.set(e.tier, (counts.get(e.tier) ?? 0) + 1);
  const roles = tierRoles(d.rows.map((r) => ({ name: r.name.trim(), reachableBy: r.reachableBy })));

  const change = (fn: (rows: DraftRow[]) => void, focusKey?: string) => {
    fn(d.rows);
    edited();
    redraw();
    if (focusKey) focus(focusKey);
  };

  const head = el('div', 'aw-orch-tierhead');
  head.setAttribute('aria-hidden', 'true');
  for (const h of ['#', '', 'Name', 'Reachable by', 'Models', '']) head.appendChild(el('span', undefined, h));
  host.appendChild(head);

  const list = el('ol', 'aw-orch-tierlist');
  d.rows.forEach((row, i) => {
    const li = el('li', `aw-orch-tierrow${row.reachableBy === 'escalation' ? ' escalation' : ''}`);
    const grid = el('div', 'aw-orch-tierrow-main');
    grid.appendChild(el('span', 'aw-orch-tierpos', String(i + 1)));

    const meter = el('span', 'aw-orch-meter');
    meter.setAttribute('aria-hidden', 'true');
    meterBars(i, d.rows.length).forEach((lit, b) => {
      const bar = el('span', 'aw-orch-meter-bar');
      bar.dataset.bar = String(b);
      bar.dataset.lit = String(lit);
      meter.appendChild(bar);
    });
    grid.appendChild(meter);

    const nameId = `aw-orch-tiername-${row.id}`;
    const errId = `aw-orch-tiererr-${row.id}`;
    const label = el('label', 'aw-orch-sr', `Tier ${i + 1} name`);
    label.htmlFor = nameId;
    const input = el('input', 'aw-orch-input aw-orch-tiername');
    input.id = nameId;
    input.type = 'text';
    input.value = row.name;
    input.spellcheck = false;
    input.dataset.focus = `tiername:${row.id}`;
    const errors = errorsAt.get(i);
    if (errors) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', errId);
    }
    input.addEventListener('input', () => {
      row.name = input.value;
      edited();
      redraw();
    });
    const nameCell = el('div', 'aw-orch-tiername-cell');
    nameCell.append(label, input);
    grid.appendChild(nameCell);

    const reach = el('div', 'aw-orch-segmented aw-orch-reach');
    reach.setAttribute('role', 'group');
    reach.setAttribute('aria-label', `Tier ${i + 1} reachable by`);
    for (const [value, text] of [
      ['route', 'Route'],
      ['escalation', 'Escalation only'],
    ] as const) {
      const b = button(text, () => {
        if (row.reachableBy !== value) change(() => void (row.reachableBy = value), `reach:${row.id}:${value}`);
      }, 'aw-orch-seg');
      b.setAttribute('aria-pressed', String(row.reachableBy === value));
      b.dataset.focus = `reach:${row.id}:${value}`;
      reach.appendChild(b);
    }
    grid.appendChild(reach);

    const n = row.origin ? (counts.get(row.origin) ?? 0) : 0;
    grid.appendChild(el('span', 'aw-orch-tiercount', n === 1 ? '1 model' : `${n} models`));

    const moves = el('div', 'aw-orch-tiermoves');
    const who = row.name.trim() || `tier ${i + 1}`;
    // Focus stays on the button that moved the row, unless the move took it to an end, where that button is disabled.
    const up = button('↑', () => change((rows) => void ([rows[i - 1], rows[i]] = [rows[i], rows[i - 1]]), i - 1 === 0 ? `down:${row.id}` : `up:${row.id}`), 'aw-orch-iconbtn');
    up.setAttribute('aria-label', `Move ${who} weaker`);
    up.dataset.focus = `up:${row.id}`;
    up.disabled = i === 0;
    const down = button('↓', () => change((rows) => void ([rows[i], rows[i + 1]] = [rows[i + 1], rows[i]]), i + 1 === d.rows.length - 1 ? `up:${row.id}` : `down:${row.id}`), 'aw-orch-iconbtn');
    down.setAttribute('aria-label', `Move ${who} stronger`);
    down.dataset.focus = `down:${row.id}`;
    down.disabled = i === d.rows.length - 1;
    const del = button('×', () => {
      const after = d.rows[i + 1] ?? d.rows[i - 1];
      change((rows) => void rows.splice(i, 1), after ? `tiername:${after.id}` : 'tier:add');
    }, 'aw-orch-iconbtn');
    del.setAttribute('aria-label', `Delete tier ${who}`);
    del.dataset.focus = `delete:${row.id}`;
    moves.append(up, down, del);
    grid.appendChild(moves);
    li.appendChild(grid);

    const sub = el('div', 'aw-orch-tierrow-sub');
    sub.appendChild(el('span', 'aw-orch-muted', tierRoleLine(roles[i])));
    if (errors) {
      const err = el('span', 'aw-orch-field-error', errors.join(' · '));
      err.id = errId;
      sub.appendChild(err);
    }
    const trimmed = row.name.trim();
    if (row.origin && trimmed && trimmed !== row.origin && n > 0) sub.appendChild(el('span', 'aw-orch-rename-note', `Its ${n === 1 ? '1 model moves' : `${n} models move`} to "${trimmed}"`));
    li.appendChild(sub);
    list.appendChild(li);
  });
  host.appendChild(list);

  const add = button('+ Add a stronger tier', () => {
    const row: DraftRow = { id: nextId++, name: '', reachableBy: 'route', aliases: [] };
    change((r) => void r.push(row), `tiername:${row.id}`);
  }, 'aw-orch-addtier');
  add.dataset.focus = 'tier:add';
  host.appendChild(add);

  if (invalid) {
    const alert = el('div', 'aw-orch-alert');
    alert.setAttribute('role', 'alert');
    alert.append(
      el('strong', undefined, 'Can’t save yet'),
      el('span', undefined, 'A tier list with a blank or duplicate name is thrown away whole, and the shipped defaults are used instead. Fix the names marked above.'),
    );
    const listError = errorsAt.get(-1);
    if (listError) alert.appendChild(el('span', undefined, listError.join(' ')));
    host.appendChild(alert);
  }

  const renames = draftRenames(d.rows);
  const impact = dirty
    ? tierListImpact({
        saved,
        rows: d.rows.map((r) => ({ name: r.name, reachableBy: r.reachableBy, ...(r.origin ? { origin: r.origin } : {}) })),
        entries: view.catalog.entries,
        globalCap: view.routing?.policy.caps?.maxTier,
      })
    : [];
  if (impact.length > 0) {
    const box = el('div', 'aw-orch-impact');
    box.appendChild(el('strong', undefined, 'What saving changes'));
    for (const line of impact) box.appendChild(el('span', undefined, line));
    host.appendChild(box);
  }

  const how = el('div', 'aw-orch-note');
  how.append(
    el('strong', undefined, 'How the router reads this list'),
    el('span', undefined, 'Rules set a minimum tier. The resolver tries exactly that tier, moves up only when nothing is available, and never enters an escalation-only tier or goes past a cap.'),
    el('span', undefined, 'Caps in routing defaults, repo and mission policy use these names. Saving applies to tasks that start afterwards; a running task keeps the list it started with.'),
  );
  host.appendChild(how);

  const footer = el('div', 'aw-orch-tierfooter');
  const statusText = invalid ? 'Unsaved · fix names to save' : saving ? 'Saving…' : dirty ? 'Unsaved changes' : (saveStatus?.text ?? 'Saved');
  const status = el('span', `aw-orch-tierstatus${invalid || saveStatus?.ok === false ? ' bad' : dirty ? ' dirty' : ''}`, saveStatus && !saveStatus.ok && !invalid ? saveStatus.text : statusText);
  status.setAttribute('role', 'status');
  footer.appendChild(status);
  const restore = button('Restore shipped tiers', () => {
    // Keep each row's id where a shipped tier is one we have (by name or old name), so it reads as a rename back, not a delete.
    const rows = DEFAULT_TIERS.map((t) => {
      const same = d.rows.find((r) => r.origin === t.name) ?? d.rows.find((r) => r.aliases.includes(t.name) && r.origin);
      return { id: same?.id ?? nextId++, name: t.name, reachableBy: t.reachableBy, ...(same?.origin ? { origin: same.origin } : {}), aliases: same?.aliases ?? [] };
    });
    change((r) => void r.splice(0, r.length, ...rows), 'tier:restore');
  }, 'aw-orch-btn quiet');
  restore.dataset.focus = 'tier:restore';
  const discard = button('Discard', () => {
    draft = fromSaved(saved);
    edited();
    redraw();
    focus('tier:discard');
  }, 'aw-orch-btn');
  discard.dataset.focus = 'tier:discard';
  discard.disabled = !dirty;
  const save = button('Save tier list', () => {
    saving = true;
    saveStatus = undefined;
    const tiers = isShippedList(d.rows) ? 'default' : d.rows.map((r) => ({ name: r.name.trim(), reachableBy: r.reachableBy }));
    post({ type: 'setTierList', tiers, renames });
    redraw();
  }, 'aw-orch-btn primary');
  save.dataset.focus = 'tier:save';
  save.disabled = !dirty || invalid || saving;
  footer.append(el('span', 'aw-orch-spacer'), restore, discard, save);
  host.appendChild(footer);
}
