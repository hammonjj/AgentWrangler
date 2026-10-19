#!/bin/sh
# Run the remote-control RLS tests (#172) against the local Supabase started by
# `npx supabase start`. Reads the local URL and keys from `supabase status`; these are the
# CLI's fixed local-development values, not secrets.
set -e
eval "$(npx -y supabase@latest status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|SERVICE_ROLE_KEY)=')"
if [ -z "$API_URL" ]; then
  echo "Local Supabase is not running. Start it with: npx supabase start" >&2
  exit 1
fi
SUPABASE_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx vitest run test/supabaseRls.integration.test.ts test/relaySupabase.integration.test.ts
