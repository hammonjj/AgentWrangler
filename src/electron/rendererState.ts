/**
 * Which window's saved state a renderer's `getState`/`setState` reach.
 *
 * Every window shares the preload, and the preload's state calls go over one
 * pair of channels that the workbench answers. A window with state of its own
 * (Preferences remembers its Orchestration tab) claims its renderer here; the
 * workbench answers a claimed renderer from the claim, and every other renderer
 * exactly as before.
 */

import type { Disposable } from '../core/events';

export interface RendererStateStore {
  get(): unknown;
  set(value: unknown): void;
}

const claims = new Map<number, RendererStateStore>();

/** Serve `webContentsId`'s state from `store` until disposed. */
export function claimRendererState(webContentsId: number, store: RendererStateStore): Disposable {
  claims.set(webContentsId, store);
  return {
    dispose: () => {
      if (claims.get(webContentsId) === store) claims.delete(webContentsId);
    },
  };
}

/** The claim for a renderer, if a window made one. */
export function claimedRendererState(webContentsId: number): RendererStateStore | undefined {
  return claims.get(webContentsId);
}
