/**
 * Password sign-in that sets the device up (#187; `docs/plans/remote-control-supabase.md` §3.1).
 *
 * The password never leaves this page. It becomes two values: `authValue`, the Supabase
 * password, and `enrollKey`, which seals an `enroll` request to the Mac. The Mac answers on a
 * topic this page joined first with a new device id and key, under a key only the two ends can
 * derive. From then on the device is the same as one paired by QR code.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  RELAY_EVENT_ENROLL,
  RELAY_EVENT_ENROLLED,
  connectionTopic,
  deriveRelayPassword,
  lobbyTopic,
  newEnrollKeyPair,
  newRelayId,
  openEnrollReply,
  parseEnrollReply,
  sealEnroll,
} from '../../shared/relay';

/** How long the Mac has to answer before the page says it did not. */
const ENROLL_TIMEOUT_MS = 20_000;

export type SignInResult =
  | { ok: true; uid: string; device?: { deviceId: string; key: string } }
  | { ok: false; why: 'credentials' | 'not-owner' | 'mac-silent' | 'refused' | 'unreachable'; message?: string };

/** "iPhone", "Android", "Mac"…: so the Mac's device list says which device signed in. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const what = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Browser';
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return standalone ? `${what} Home Screen app` : what;
}

/**
 * Sign in with the remote password, then, when `enroll` is set, ask the Mac for a device key.
 * A device that already has a key only signs in.
 */
export async function signInWithPassword(client: SupabaseClient, email: string, password: string, enroll: boolean): Promise<SignInResult> {
  const values = await deriveRelayPassword(email, password);
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password: values.authValue });
  if (error || !data.session || !data.user) return { ok: false, why: 'credentials', message: error?.message };
  await client.realtime.setAuth(data.session.access_token);
  const uid = data.user.id;
  if (!enroll) return { ok: true, uid };

  const t = newRelayId();
  const own = await newEnrollKeyPair();
  const channel = client.channel(connectionTopic(uid, t), { config: { private: true, broadcast: { self: false } } });
  try {
    let answered: (payload: unknown) => void = () => undefined;
    const answer = new Promise<unknown>((resolve) => (answered = resolve));
    channel.on('broadcast', { event: RELAY_EVENT_ENROLLED }, (m) => answered(m.payload));
    // Joined before asking, so the answer cannot arrive before anyone listens.
    const joined = await new Promise<'ok' | 'not-owner' | 'unreachable'>((resolve) => {
      channel.subscribe((status, err) => {
        if (status === 'SUBSCRIBED') resolve('ok');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') resolve(err?.message?.includes('nauthorized') ? 'not-owner' : 'unreachable');
      });
    });
    if (joined !== 'ok') return { ok: false, why: joined };

    const lobby = client.channel(lobbyTopic(uid), { config: { private: true } });
    const r = await lobby.httpSend(RELAY_EVENT_ENROLL, await sealEnroll(values.enrollKey, uid, t, own.pub, deviceLabel(), Date.now()));
    void client.removeChannel(lobby);
    if (!r.success) return { ok: false, why: r.status === 401 || r.status === 403 ? 'not-owner' : 'unreachable' };

    const raw = await Promise.race([answer, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ENROLL_TIMEOUT_MS))]);
    if (raw === undefined) return { ok: false, why: 'mac-silent' };
    const reply = parseEnrollReply(raw);
    const device = reply ? await openEnrollReply(values.enrollKey, uid, t, own, reply) : undefined;
    if (!device) return { ok: false, why: 'refused' };
    return { ok: true, uid, device };
  } finally {
    void client.removeChannel(channel);
  }
}
