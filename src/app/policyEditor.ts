/**
 * The mission and task override editors (§10.2, §18.3; #40): quick picks, as
 * the launcher's task flow is (#38), reached from the task strip's "Policy…"
 * button and from the Tasks menu.
 *
 * One field at a time, and each change is saved — or refused — the moment it
 * is picked: a pin that breaks a cap is an error shown then, naming both
 * scopes, never a draft that fails later. What a field says is its value at
 * this scope ("inherit" when it sets none) and the value in force, with the
 * scope that set it, so a person can see what they are overriding.
 */
import type { HostDialogs } from '../host/hostServices';
import type { TaskRunner } from '../orchestration/engine/taskRunner';
import { TaskError } from '../orchestration/engine/taskRunner';
import { harnessLabel } from '../shared/harness';
import type { CapabilityCatalogView } from '../shared/orchestration/catalog';
import {
  POLICY_FIELDS,
  fieldValue,
  missionLayer,
  scopeTag,
  taskLayer,
  valueText,
  withField,
  type PolicyFieldSpec,
  type PolicyValue,
} from '../shared/orchestration/executionPolicy';
import { EFFORT_LEVELS, type ExecutionPolicy } from '../shared/orchestration/types';

export interface PolicyEditorDeps {
  dialogs: HostDialogs;
  runner: TaskRunner;
  catalog: () => CapabilityCatalogView;
  log: (msg: string) => void;
}

const HARNESSES = ['claude-code', 'codex'] as const;

/** "Policy…": pick the scope, then edit it. */
export async function editPolicy(d: PolicyEditorDeps, missionId: string): Promise<void> {
  const m = d.runner.get(missionId);
  if (!m) return;
  const scope = await d.dialogs.pick(
    [
      { label: 'Mission policy', description: 'this mission', detail: 'Pins, caps, preferences and exclusions for the whole mission.', scope: 'mission' as const },
      { label: 'Task overrides', description: m.tasks[0]?.key ?? 'the task', detail: 'The most specific scope: wins over the mission, but can only tighten its caps.', scope: 'task' as const },
    ],
    { placeHolder: `Policy — ${m.title}`, matchOnDetail: true },
  );
  if (scope) await editScope(d, missionId, scope.scope);
}

async function editScope(d: PolicyEditorDeps, missionId: string, scope: 'mission' | 'task'): Promise<void> {
  for (;;) {
    const m = d.runner.get(missionId);
    const eff = d.runner.effectivePolicy(missionId);
    if (!m || !eff) return;
    const layer = scope === 'mission' ? missionLayer(m) : taskLayer(m.tasks[0].overrides);
    const next = m.tasks[0].attemptIds.length + 1;
    type Row = { label: string; description?: string; detail?: string; spec?: PolicyFieldSpec; done?: true };
    const rows: Row[] = POLICY_FIELDS.map((spec) => {
      const here = fieldValue(layer, spec.field);
      const inForce = fieldValue(eff.policy, spec.field);
      const from = eff.from[spec.field];
      return {
        label: `${spec.group}: ${spec.label} — ${here === undefined ? 'inherit' : valueText(spec.field, here)}`,
        description: inForce === undefined ? 'not set' : `in force: ${valueText(spec.field, inForce)}${from ? ` (${scopeTag(from)})` : ''}`,
        detail: spec.help,
        spec,
      };
    });
    rows.push({ label: '$(check) Done', description: m.state === 'draft' ? 'not started yet' : `changes apply from attempt ${next}`, done: true });
    const picked = await d.dialogs.pick(rows, {
      placeHolder: `${scope === 'mission' ? 'Mission policy' : 'Task overrides'} — ${m.title}`,
      matchOnDescription: true,
    });
    if (!picked || picked.done || !picked.spec) return;
    const value = await askValue(d, picked.spec, fieldValue(layer, picked.spec.field));
    if (value === CANCELLED) continue;
    let updated: ExecutionPolicy = withField(layer, picked.spec.field, value);
    // A pinned model needs a harness to run on; the model's own, unless one is pinned already.
    if (picked.spec.field === 'pins.model' && typeof value === 'string' && !fieldValue(updated, 'pins.harness')) {
      const entry = d.catalog().entries.find((e) => e.aliases.includes(value) || e.descriptor.modelId === value);
      if (entry?.harnesses[0]) updated = withField(updated, 'pins.harness', entry.harnesses[0]);
    }
    try {
      const after = await d.runner.setPolicy(missionId, scope, updated);
      const change = after.policyChanges.length > m.policyChanges.length ? after.policyChanges.at(-1) : undefined;
      d.dialogs.flash(change ? `${picked.spec.label} changed; applies from attempt ${change.appliesFromAttempt}` : `${picked.spec.label} saved`);
    } catch (error) {
      d.log(`task ${missionId}: policy refused: ${String(error)}`);
      d.dialogs.error(`Agent Wrangler: ${error instanceof TaskError ? error.message : (error as Error).message}`);
    }
  }
}

const CANCELLED = Symbol('cancelled');

/** The new value for one field: a value, `undefined` to inherit again, or `CANCELLED`. */
async function askValue(d: PolicyEditorDeps, spec: PolicyFieldSpec, current: PolicyValue | undefined): Promise<PolicyValue | undefined | typeof CANCELLED> {
  const inherit = { label: 'Inherit', description: 'set nothing here', value: undefined as PolicyValue | undefined };
  const choose = async (options: { label: string; description?: string; value: PolicyValue | undefined }[]) => {
    const picked = await d.dialogs.pick([...options, inherit], { placeHolder: `${spec.label} — ${spec.help}` });
    return picked ? picked.value : CANCELLED;
  };
  switch (spec.kind) {
    case 'tier':
      return choose(d.catalog().tiers.map((t) => ({ label: t.name, description: t.reachableBy === 'escalation' ? 'escalation only' : undefined, value: t.name })));
    case 'effort':
      return choose(EFFORT_LEVELS.map((l) => ({ label: l, value: l })));
    case 'location':
      return choose([
        { label: 'local-only', value: 'local-only' },
        { label: 'hosted-only', value: 'hosted-only' },
      ]);
    case 'harness':
      return choose(HARNESSES.map((h) => ({ label: harnessLabel(h), value: h })));
    case 'model':
      return choose(
        d.catalog()
          .entries.filter((e) => e.enabled)
          .map((e) => ({
            label: e.descriptor.label,
            description: `${e.tier ?? 'unassigned'} · ${e.harnesses.map(harnessLabel).join(', ')}`,
            value: e.aliases[0] ?? e.descriptor.modelId,
          })),
      );
    case 'flag':
      return choose([{ label: 'Yes', value: true }]);
    case 'harnesses': {
      const now = Array.isArray(current) ? current.map(String) : [];
      const picked = await d.dialogs.pick(
        [
          ...HARNESSES.map((h) => ({ label: `${now.includes(h) ? 'Allow' : 'Exclude'} ${harnessLabel(h)}`, harness: h as string | undefined })),
          { label: 'Inherit', description: 'exclude nothing here', harness: undefined },
        ],
        { placeHolder: `${spec.label} — now ${now.length === 0 ? 'none' : now.map(harnessLabel).join(', ')}` },
      );
      if (!picked) return CANCELLED;
      if (!picked.harness) return undefined;
      return now.includes(picked.harness) ? now.filter((h) => h !== picked.harness) : [...now, picked.harness];
    }
    case 'count':
    case 'usd':
    case 'percent': {
      const text = await d.dialogs.input({
        title: spec.label,
        prompt: `${spec.help} Leave empty to inherit.`,
        value: current === undefined ? '' : String(current),
        validateInput: (v) => numberComplaint(spec, v),
      });
      if (text === undefined) return CANCELLED;
      return text.trim() === '' ? undefined : Number(text.trim());
    }
  }
}

/** Why a typed number will not do, or undefined when it will. The runner validates again. */
export function numberComplaint(spec: Pick<PolicyFieldSpec, 'kind' | 'min' | 'max'>, text: string): string | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  const n = Number(t);
  if (!Number.isFinite(n)) return 'Type a number.';
  if (spec.kind === 'count' && !Number.isInteger(n)) return 'Type a whole number.';
  if (spec.kind === 'usd' && n <= 0) return 'Type an amount above 0.';
  if (spec.min !== undefined && n < spec.min) return `At least ${spec.min}.`;
  if (spec.max !== undefined && n > spec.max) return `At most ${spec.max}.`;
  return undefined;
}
