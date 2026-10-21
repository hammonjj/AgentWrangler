# Remote control: one-time setup

How to stand up the Supabase project and Netlify site that remote control (#112) uses. Design:
[`plans/remote-control-supabase.md`](plans/remote-control-supabase.md). Everything here stays on
the free tiers.

## 1. Supabase project

1. Create a project at supabase.com (free plan). Any region close to you.
2. Apply the schema: either
   - `npx supabase link --project-ref <ref>` and then `npx supabase db push`, or
   - paste `supabase/migrations/*.sql` into the SQL editor, oldest first.
3. Note the **Project URL** and the **anon / publishable key** (Settings › API). Both are public
   values: they go into Agent Wrangler's settings and into the Netlify loader. Never use the
   `service_role` / secret key anywhere in the app.

## 2. GitHub sign-in

1. On GitHub: Settings › Developer settings › OAuth Apps › New OAuth App.
   - Homepage URL: `https://agentwrangler.netlify.app`
   - Authorization callback URL: `https://<project-ref>.supabase.co/auth/v1/callback`
2. In Supabase: Authentication › Sign In / Providers › GitHub: enable it, and paste the client
   id and a client secret.
3. Authentication › URL Configuration:
   - Site URL: `https://agentwrangler.netlify.app`
   - Redirect URLs: `https://agentwrangler.netlify.app/**` and
     `http://127.0.0.1:*/remote/callback` (the daemon's own sign-in).
4. Leave **Email** on (it is on by default): a phone signs in with your email and the remote
   password (#187). Turn off the other providers you do not use. Sign-ups stay closed (§3), so
   Email lets no one new in. Leave "Secure password change" off, or the daemon cannot set the
   password from Preferences.

## 2a. Password sign-in

On the Mac, once Remote control says it is connected: Preferences › Remote control ›
**Set password…**. The password is not stored anywhere. The Mac turns it into the Supabase
password for your account and an enrollment key it keeps in the Keychain (plan §3.1). On the
phone, open the site (or its Home Screen icon) and sign in with your account's email and that
password. This also sets the phone up, and it shows under Browser › Devices as "(password)".

## 3. Make yourself the owner, then close sign-ups

1. Sign in once with GitHub (from the Netlify site, or Preferences › Remote on the Mac). This
   creates your user with a profile whose role is `none`. It can do nothing yet.
2. In the SQL editor:
   ```sql
   update public.profiles set role = 'owner'
   where user_id = (select id from auth.users order by created_at limit 1);
   ```
   Check that it is the right user first (`select id, email, created_at from auth.users`).
3. Authentication › Sign In / Providers: turn **Allow new users to sign up** off. A stranger
   with a GitHub account now cannot even create a user.

## 4. Netlify site

The site is `agentwrangler.netlify.app`. It serves only the static loader
(`dist/relay-site/`, built by `npm run build`). The build also writes `project.json` there from
this Mac's `remote.relay.url` and `remote.relay.anonKey` settings. It tells a phone that has
nothing stored which project to sign in to. Build on the Mac with those settings before
deploying, or password sign-in on a new device says "Not set up".

- Site settings › Build & deploy: **stop auto publishing / builds.** A production deploy costs
  about 15 of the free plan's 300 monthly credits, and the loader only changes when
  `src/webview/relayLoader/` does.
- Deploy by hand: `npx netlify-cli deploy --prod --dir dist/relay-site --site <site id>` with
  a personal access token in `NETLIFY_AUTH_TOKEN`, or with the Netlify MCP server
  (`npx -y @netlify/mcp`). Keep the token out of the repo.
- Turn on 2FA for the Netlify account: whoever can deploy the loader can run code on a page
  that holds a device key (plan §5).

## When a remote tab is slow or hangs

See `docs/relay-troubleshooting.md`: which front end is which, the log lines that explain a
reconnect, and what was found the first time.

## Local testing

`npx supabase start` runs the same schema in Docker (`supabase/config.toml`), and
`npm run test:supabase` runs the RLS tests against it. `npx supabase stop` stops it.
