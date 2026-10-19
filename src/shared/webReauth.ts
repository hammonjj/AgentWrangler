/**
 * LAN recovery for a browser that lost its device cookie. The page keeps a
 * recovery token in `localStorage` under `REAUTH_STORAGE_KEY`; the server's
 * not-signed-in page offers it at `REAUTH_PATH` for a new cookie.
 */
export const REAUTH_PATH = '/reauth';
export const REAUTH_TOKEN_PATH = '/reauth/token';
export const REAUTH_STORAGE_KEY = 'aw.reauth';
