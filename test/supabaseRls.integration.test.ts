/**
 * Row-level security and Realtime authorisation for remote control (#172), against a LOCAL
 * Supabase (`npm run test:supabase` starts nothing; run `npx supabase start` first, then it
 * reads the local URL and keys). Skipped when SUPABASE_URL is not set, so `npm test` never
 * needs Docker.
 *
 * Users are created through the local admin API with email/password: GitHub OAuth cannot be
 * driven from a test, and RLS only sees auth.uid(), never the provider.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);

interface TestUser {
  id: string;
  client: SupabaseClient;
}

describe.runIf(enabled)('remote control: Supabase RLS (local)', { timeout: 30_000 }, () => {
  let admin: SupabaseClient;
  const users: TestUser[] = [];

  async function makeUser(role: 'none' | 'owner'): Promise<TestUser> {
    const email = `rls-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw created.error ?? new Error('no user');
    const id = created.data.user.id;
    if (role === 'owner') {
      const { error } = await admin.from('profiles').update({ role: 'owner' }).eq('user_id', id);
      if (error) throw error;
    }
    const client = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = await client.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    await client.realtime.setAuth(signed.data.session!.access_token);
    const user = { id, client };
    users.push(user);
    return user;
  }

  /** Join a private topic; resolves with the final subscribe status. */
  function join(client: SupabaseClient, topic: string): Promise<{ status: string; channel: ReturnType<SupabaseClient['channel']> }> {
    const channel = client.channel(topic, { config: { private: true, broadcast: { self: false } } });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'TIMED_OUT', channel }), 8_000);
      channel.subscribe((status, err) => {
        if (process.env.RLS_DEBUG) console.log(topic, status, err?.message);
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'CLOSED') {
          clearTimeout(timer);
          resolve({ status, channel });
        }
      });
    });
  }

  beforeAll(() => {
    admin = createClient(url!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  });

  afterAll(async () => {
    for (const u of users) {
      await u.client.removeAllChannels();
      await admin.auth.admin.deleteUser(u.id);
    }
  });

  it('gives every new user a profile with no role, readable only by them', async () => {
    const a = await makeUser('none');
    const b = await makeUser('none');
    const own = await a.client.from('profiles').select('role').eq('user_id', a.id);
    expect(own.data).toEqual([{ role: 'none' }]);
    const other = await a.client.from('profiles').select('role').eq('user_id', b.id);
    expect(other.data).toEqual([]);
  });

  it('does not let a user grant themselves a role', async () => {
    const a = await makeUser('none');
    await a.client.from('profiles').update({ role: 'owner' }).eq('user_id', a.id);
    const after = await admin.from('profiles').select('role').eq('user_id', a.id).single();
    expect(after.data?.role).toBe('none');
  });

  it('refuses a daemon heartbeat from a user who is not an owner', async () => {
    const a = await makeUser('none');
    const { error } = await a.client.from('daemons').insert({ id: randomUUID(), build: 'b1' });
    expect(error).not.toBeNull();
  });

  it('lets an owner write and update their own heartbeat, and nobody else read it', async () => {
    const owner = await makeUser('owner');
    const otherOwner = await makeUser('owner');
    const id = randomUUID();
    const inserted = await owner.client.from('daemons').insert({ id, build: 'b1' });
    expect(inserted.error).toBeNull();
    const updated = await owner.client.from('daemons').update({ build: 'b2', last_seen_at: new Date().toISOString() }).eq('id', id).select('build');
    expect(updated.data).toEqual([{ build: 'b2' }]);

    const seen = await otherOwner.client.from('daemons').select('id').eq('id', id);
    expect(seen.data).toEqual([]);
    // Nor take it over by naming another user.
    const hijack = await otherOwner.client.from('daemons').insert({ id: randomUUID(), user_id: owner.id, build: 'x' });
    expect(hijack.error).not.toBeNull();
  });

  it('lets an owner join their own private topics and nobody else\'s', async () => {
    const owner = await makeUser('owner');
    const otherOwner = await makeUser('owner');
    const mine = await join(owner.client, `aw:${owner.id}:lobby`);
    expect(mine.status).toBe('SUBSCRIBED');
    const theirs = await join(otherOwner.client, `aw:${owner.id}:lobby`);
    expect(theirs.status).toBe('CHANNEL_ERROR');
    const unprefixed = await join(owner.client, `other:${owner.id}:lobby`);
    expect(unprefixed.status).toBe('CHANNEL_ERROR');
  });

  it('refuses a user who is not an owner even on their own topic', async () => {
    const a = await makeUser('none');
    const joined = await join(a.client, `aw:${a.id}:lobby`);
    expect(joined.status).toBe('CHANNEL_ERROR');
  });

  it('carries a broadcast between two sessions of the same owner', async () => {
    const owner = await makeUser('owner');
    const second = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
    // The same user's second session: the daemon and a phone are both James.
    const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: (await admin.auth.admin.getUserById(owner.id)).data.user!.email! });
    const verified = await second.auth.verifyOtp({ token_hash: link.properties!.hashed_token, type: 'magiclink' });
    expect(verified.error).toBeNull();
    await second.realtime.setAuth(verified.data.session!.access_token);

    const topic = `aw:${owner.id}:c:${randomUUID()}`;
    const receiver = await join(owner.client, topic);
    expect(receiver.status).toBe('SUBSCRIBED');
    const got = new Promise<unknown>((resolve) => receiver.channel.on('broadcast', { event: 'f' }, (m) => resolve(m.payload)));
    const sender = await join(second, topic);
    expect(sender.status).toBe('SUBSCRIBED');
    await sender.channel.send({ type: 'broadcast', event: 'f', payload: { c: 'ciphertext' } });
    await expect(got).resolves.toEqual({ c: 'ciphertext' });
    await second.removeAllChannels();
  });

  it('removes every row of a deleted user', async () => {
    const owner = await makeUser('owner');
    await owner.client.from('daemons').insert({ id: randomUUID(), build: 'b1' });
    await admin.auth.admin.deleteUser(owner.id);
    users.splice(users.indexOf(owner), 1);
    const profiles = await admin.from('profiles').select('user_id').eq('user_id', owner.id);
    const daemons = await admin.from('daemons').select('id').eq('user_id', owner.id);
    expect(profiles.data).toEqual([]);
    expect(daemons.data).toEqual([]);
  });
});
