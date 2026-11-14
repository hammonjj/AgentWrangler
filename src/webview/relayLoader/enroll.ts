/**
 * Password sign-in (#187, simplified; `docs/plans/remote-control-supabase.md` §3.1).
 *
 * The password never leaves this page. It becomes `authValue`, the Supabase password, and
 * `enrollKey`, from which this page derives the account device (id and key) that the Mac
 * derives the same way. There is nothing to register and nothing that expires: knowing the
 * password is the whole credential.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveAccountDevice, deriveRelayPassword } from '../../shared/relay';

export type SignInResult =
  | { ok: true; uid: string; device: { deviceId: string; key: string } }
  | { ok: false; why: 'credentials'; message?: string };

/** Sign in with the remote password, and derive the account device from it. */
export async function signInWithPassword(client: SupabaseClient, email: string, password: string): Promise<SignInResult> {
  const values = await deriveRelayPassword(email, password);
  const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password: values.authValue });
  if (error || !data.session || !data.user) return { ok: false, why: 'credentials', message: error?.message };
  await client.realtime.setAuth(data.session.access_token);
  return { ok: true, uid: data.user.id, device: await deriveAccountDevice(values.enrollKey) };
}
