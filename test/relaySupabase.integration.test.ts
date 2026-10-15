/**
 * The relay end to end through a LOCAL Supabase (#173): the daemon's link signs in with a
 * refresh token, a second session of the same owner plays the phone, and a workbench envelope
 * goes out and back through Realtime, sealed both ways. Run with `npm run test:supabase`
 * after `npx supabase start`; skipped otherwise.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { ClientSocket } from '../src/core/web/browserConnections';
import { startRelayLink } from '../src/remote/relay/relayLink';
import { connectSupabaseNetwork } from '../src/remote/relay/supabaseNetwork';
import {
  RELAY_EVENT_CONNECT,
  RELAY_EVENT_FRAME,
  RelayCodec,
  connectionTopic,
  importRelayKey,
  lobbyTopic,
  newRelayId,
  newRelayKey,
  parseSealedPart,
  sealConnect,
  type RelayItem,
} from '../src/shared/relay';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.runIf(Boolean(url && anonKey && serviceKey))('relay through local Supabase', { timeout: 60_000 }, () => {
  const cleanup: (() => Promise<unknown> | unknown)[] = [];
  afterAll(async () => {
    for (const c of cleanup.reverse()) await c();
  });

  it('carries a sealed envelope from a phone to the daemon and back', async () => {
    const admin = createClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = `relay-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const { data: created } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    const uid = created.user!.id;
    cleanup.push(() => admin.auth.admin.deleteUser(uid));
    await admin.from('profiles').update({ role: 'owner' }).eq('user_id', uid);

    // The daemon: a refresh token, as the Keychain would hold it.
    const daemonLogin = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await daemonLogin.auth.signInWithPassword({ email, password });
    const tokens: string[] = [];
    const network = await connectSupabaseNetwork({
      url: url!,
      anonKey: anonKey!,
      refreshToken: signed.data.session!.refresh_token,
      onRefreshToken: (t) => tokens.push(t),
      onSignedOut: () => undefined,
      log: () => undefined,
    });
    cleanup.push(() => network.dispose());
    expect(network.uid).toBe(uid);
    expect(tokens).toHaveLength(1); // rotated on sign-in, handed back to be kept

    const keyText = newRelayKey();
    const link = await startRelayLink({
      network,
      keyOf: (id) => (id === 'phone' ? keyText : undefined),
      attach: (socket: ClientSocket) => {
        socket.send('{"pane":"shell","body":{"type":"hello"}}');
        socket.on('message', (d) => socket.send(`echo:${String(d)}`));
      },
      build: () => 'b-test',
      daemonId: randomUUID(),
      log: () => undefined,
    });
    cleanup.push(() => link.dispose());

    // The heartbeat row is there, under this user.
    await new Promise((r) => setTimeout(r, 500));
    const beats = await admin.from('daemons').select('build').eq('user_id', uid);
    expect(beats.data).toEqual([{ build: 'b-test' }]);

    // The phone: another session of the same owner.
    const phone: SupabaseClient = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const ps = await phone.auth.signInWithPassword({ email, password });
    await phone.realtime.setAuth(ps.data.session!.access_token);
    cleanup.push(() => phone.removeAllChannels());
    const key = await importRelayKey(keyText);
    const connId = newRelayId();
    const topic = connectionTopic(uid, connId);
    const codec = new RelayCodec(key, 'phone', topic, 'b2d');
    const received: RelayItem[] = [];
    let chain = Promise.resolve();
    const join = (t: string) =>
      new Promise<ReturnType<SupabaseClient['channel']>>((resolve, reject) => {
        const ch = phone.channel(t, { config: { private: true, broadcast: { self: false, ack: true } } });
        if (t === topic) {
          ch.on('broadcast', { event: RELAY_EVENT_FRAME }, (m) => {
            chain = chain.then(async () => {
              const items = await codec.open(parseSealedPart(m.payload)!);
              received.push(...(items ?? [{ k: 'close', reason: 'refused' } as RelayItem]));
            });
          });
        }
        ch.subscribe((s, err) => (s === 'SUBSCRIBED' ? resolve(ch) : s === 'CHANNEL_ERROR' ? reject(err) : undefined));
      });
    const channel = await join(topic);
    const lobby = await join(lobbyTopic(uid));
    await lobby.send({ type: 'broadcast', event: RELAY_EVENT_CONNECT, payload: await sealConnect(key, 'phone', uid, connId, Date.now()) });

    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
    };
    await until(() => received.length >= 2);
    expect(received.slice(0, 2)).toEqual([
      { k: 'open', build: 'b-test', protocol: 1 },
      { k: 'data', line: '{"pane":"shell","body":{"type":"hello"}}' },
    ]);

    for (const p of await codec.seal([{ k: 'data', line: 'ping-from-phone' }])) {
      await channel.send({ type: 'broadcast', event: RELAY_EVENT_FRAME, payload: p });
    }
    await until(() => received.some((i) => i.k === 'data' && i.line === 'echo:ping-from-phone'));
    expect(received.at(-1)).toEqual({ k: 'data', line: 'echo:ping-from-phone' });
    expect(link.tabs).toBe(1);
  });
});
