/**
 * Preferences → Agents and status → Agent mission control: one switch per
 * durable agent, off by default (`docs/plans/agent-mission-control.md`).
 *
 * With it on, that agent may accept, finish or cancel a mission it delegated
 * itself, from its own conversation (`aw mission …`), and only once the
 * mission passed its verification checks. It never merges locally on its own
 * word: that waits for Confirm merge in Missions. Every attempt is audited
 * and listed under the mission.
 */
import type { MissionGrantAgentView } from '../../shared/orchestration/missionGrant';
import type { PreferencesToHost } from '../../shared/preferences';

export const MISSION_GRANTS_GROUP = 'Agents and status';

let agents: MissionGrantAgentView[] = [];
let error: string | undefined;
let container: HTMLElement | undefined;
let errorLine: HTMLElement | undefined;
let post: ((message: PreferencesToHost) => void) | undefined;
/** Switches pressed and not yet answered: off until the host's list says what is stored. */
const pending = new Set<string>();

export function createMissionGrantsBlock(send: (message: PreferencesToHost) => void): HTMLElement {
  post = send;
  const block = document.createElement('div');
  block.className = 'pf-row pf-devices pf-grants';
  const head = document.createElement('div');
  head.className = 'pf-head';
  const label = document.createElement('span');
  label.className = 'pf-label';
  label.textContent = 'Agent mission control';
  head.append(label);
  const desc = document.createElement('p');
  desc.className = 'pf-desc';
  desc.textContent =
    'Lets a durable agent accept, finish or cancel the missions it delegated itself, from its own conversation, once their checks passed. ' +
    'It cannot touch another conversation’s missions or an unverified one, and a local merge always waits for you to press Confirm merge in Missions. ' +
    'Every attempt is listed under the mission. Off for every agent until you turn it on here.';
  const line = document.createElement('p');
  line.className = 'pf-desc pf-grant-error';
  line.setAttribute('role', 'alert');
  line.hidden = true;
  const list = document.createElement('div');
  list.className = 'pf-devicelist';
  block.append(head, desc, line, list);
  container = list;
  errorLine = line;
  draw();
  return block;
}

export function setMissionGrants(next: MissionGrantAgentView[], refused?: string): void {
  agents = next;
  error = refused;
  pending.clear();
  draw();
}

function draw(): void {
  const list = container;
  if (!list) return;
  if (errorLine) {
    errorLine.textContent = error ?? '';
    errorLine.hidden = !error;
  }
  list.textContent = '';
  if (agents.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pf-desc';
    empty.textContent = 'No durable agents yet. Create one under Agents; it starts with mission control off.';
    list.appendChild(empty);
    return;
  }
  for (const a of agents) {
    const row = document.createElement('label');
    row.className = 'pf-device pf-grant';
    const text = document.createElement('span');
    text.className = 'pf-devicetext';
    const name = document.createElement('span');
    name.className = 'pf-devicename';
    name.textContent = a.name;
    const meta = document.createElement('span');
    meta.className = 'pf-devicemeta';
    meta.textContent = a.granted ? `On${a.grantedAt ? ` since ${new Date(a.grantedAt).toLocaleDateString()}` : ''}${a.role ? ` · ${a.role}` : ''}` : `Off${a.role ? ` · ${a.role}` : ''}`;
    text.append(name, meta);
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'pf-check';
    box.checked = a.granted;
    box.disabled = pending.has(a.agentId);
    box.setAttribute('aria-label', `Mission control for ${a.name}`);
    box.addEventListener('change', () => {
      pending.add(a.agentId);
      box.disabled = true;
      post?.({ type: 'missionGrant', agentId: a.agentId, enabled: box.checked });
    });
    row.append(text, box);
    list.appendChild(row);
  }
}
