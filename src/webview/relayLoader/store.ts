/**
 * What the loader keeps on the device (#175), in IndexedDB:
 *
 * - `device`: the pairing — device id, the project, and the key as a **non-extractable**
 *   `CryptoKey`. IndexedDB can hold a CryptoKey as is; script can use it but never read its bytes.
 * - `assets`: the workbench's files for one build, so a reload does not download them again.
 *   Only the latest build is kept.
 */
import type { RelayProject } from '../../shared/relay';

const DB = 'agent-wrangler-relay';
const STORE = 'kv';

export interface StoredDevice {
  deviceId: string;
  key: CryptoKey;
  project: RelayProject;
  pairedAt: number;
}

export interface StoredAssets {
  build: string;
  files: { name: string; type: string; text: string }[];
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const d = await db();
  return new Promise<T>((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      d.close();
      resolve(req.result as T);
    };
    tx.onerror = () => {
      d.close();
      reject(tx.error);
    };
  });
}

export const loadDevice = () => run<StoredDevice | undefined>('readonly', (s) => s.get('device'));
export const saveDevice = (d: StoredDevice) => run<unknown>('readwrite', (s) => s.put(d, 'device'));
export const forgetDevice = () => run<unknown>('readwrite', (s) => s.delete('device'));
export const loadAssets = () => run<StoredAssets | undefined>('readonly', (s) => s.get('assets'));
export const saveAssets = (a: StoredAssets) => run<unknown>('readwrite', (s) => s.put(a, 'assets'));
