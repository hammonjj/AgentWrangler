import { describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/events';
import { waitForAdoptable } from '../src/core/adoptQueue';
import type { AgentSession } from '../src/shared/model';

function fixture(status: AgentSession['status'], estimated = false) {
  let session = { key: 's', status, statusIsEstimated: estimated } as AgentSession;
  const changed = new Emitter<void>();
  return {
    get: () => session,
    onDidUpdate: (fn: () => void) => changed.event(fn),
    update(next: Partial<AgentSession>) { session = { ...session, ...next }; changed.fire(); },
  };
}
describe('adopt queue', () => {
  it('waits for hook-backed idle without accepting blocked or stuck as idle', async () => {
    const store = fixture('busy'); const abort = new AbortController(); let ready = false;
    const done = waitForAdoptable(store, 's', abort.signal).then(() => { ready = true; });
    store.update({ status: 'blocked' }); await Promise.resolve(); expect(ready).toBe(false);
    store.update({ status: 'stuck' }); await Promise.resolve(); expect(ready).toBe(false);
    store.update({ status: 'done' }); await done; expect(ready).toBe(true);
  });
  it('rejects estimated busy status instead of killing an inferred idle process', async () => {
    await expect(waitForAdoptable(fixture('busy', true), 's', new AbortController().signal)).rejects.toThrow('estimated');
  });
  it('cancels without waiting for a future store update', async () => {
    const abort = new AbortController(); const pending = waitForAdoptable(fixture('busy'), 's', abort.signal);
    abort.abort(); await expect(pending).rejects.toThrow('draft is preserved');
  });
  it('accepts an already-ended session and rejects an already cancelled send', async () => {
    await expect(waitForAdoptable(fixture('ended'), 's', new AbortController().signal)).resolves.toBeUndefined();
    const abort = new AbortController(); abort.abort();
    await expect(waitForAdoptable(fixture('done'), 's', abort.signal)).rejects.toThrow('cancelled');
  });
  it('rejects a loss of exact status while waiting', async () => {
    const store = fixture('busy'); const pending = waitForAdoptable(store, 's', new AbortController().signal);
    store.update({ statusIsEstimated: true });
    await expect(pending).rejects.toThrow('estimated');
  });
});

it('routes estimated busy status to explicit confirmation only when the caller requests it', async () => {
  await expect(waitForAdoptable(fixture('busy', true), 's', new AbortController().signal, true)).resolves.toBeUndefined();
});
