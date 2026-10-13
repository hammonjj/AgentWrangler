/**
 * The exclusive-resource lease hook (#68), `lease-hook.sh`.
 *
 * Design: `docs/plans/spikes/f2-resource-leases.md`. The agent never asks for a
 * lease; a tool call that matches a declared resource is the request. On
 * `PreToolUse` the script takes the lease (an atomic `mkdir`), waits a bounded
 * time when another session holds it, and denies the call with a readable
 * reason when the wait runs out. `PostToolUse`/`PostToolUseFailure` release a
 * command-scoped lease, `Stop`/`StopFailure` a turn-scoped one.
 *
 * The lease directory sits next to the script, so the hook needs no core: it
 * grants and refuses while the core is down, which is exactly when `aw-app` (an
 * install that restarts the core) has to hold.
 *
 * It never prints `allow`. A granted lease exits 0 with no output and the
 * normal permission flow runs afterwards; an allow would turn a coordination
 * hook into a permission bypass.
 *
 * Fails open: anything it cannot do (no lease directory, an unreadable
 * payload) exits 0 and lets the call run, as a killed hook would anyway
 * (spike evidence 1). Leases are coordination, not security.
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export const LEASE_SCRIPT_NAME = 'lease-hook.sh';
/** Bumped whenever the script text changes. */
export const LEASE_SCRIPT_VERSION = 1;
/** The lease directory, beside the script. */
export const LEASES_DIR_NAME = 'leases';
export const RESOURCES_FILE_NAME = 'resources.tsv';
/** `cancel/<session id>`: the core's "Stop waiting"; the waiting hook denies at once. */
export const CANCEL_DIR_NAME = 'cancel';

/** Longer than `MAX_WAIT_SEC` plus slack: a hook killed by its timeout lets the call run (spike evidence 1). */
export const LEASE_HOOK_TIMEOUT_SECONDS = 1800;
/** Releases are quick; this is a guard. */
export const LEASE_RELEASE_TIMEOUT_SECONDS = 10;

/** Synthetic hook-log events the script writes, in the session's own `<pid>.jsonl`. */
export const LEASE_ACQUIRED_EVENT = 'AgentWranglerLeaseAcquired';
export const LEASE_WAITING_EVENT = 'AgentWranglerLeaseWaiting';
export const LEASE_DENIED_EVENT = 'AgentWranglerLeaseDenied';
export const LEASE_RELEASED_EVENT = 'AgentWranglerLeaseReleased';

/**
 * Which of the script's modes each hook event runs. `PermissionDenied` ends
 * a call that took its lease in `PreToolUse` and then never ran: no
 * `PostToolUse` follows a refused prompt.
 */
export const LEASE_HOOK_MODES: Readonly<Record<string, 'pre' | 'post' | 'stop'>> = {
  PreToolUse: 'pre',
  PostToolUse: 'post',
  PostToolUseFailure: 'post',
  PermissionDenied: 'post',
  Stop: 'stop',
  StopFailure: 'stop',
};

/**
 * The core touches the `holder.json` of every attempt lease it keeps, each
 * reaper pass. While that is this recent, the hook leaves the lease alone
 * whatever its pid says: the pid may be the core's, and the core may be
 * restarting (`app:install`).
 */
export const ATTEMPT_HEARTBEAT_MINUTES = 10;

export function leaseScriptPath(logDir: string): string {
  return path.join(logDir, LEASE_SCRIPT_NAME);
}

export function leasesDir(logDir: string): string {
  return path.join(logDir, LEASES_DIR_NAME);
}

/** The command a hook event runs, or undefined for events the lease hook does not need. */
export function leaseHookCommandFor(logDir: string, event: string): string | undefined {
  const mode = LEASE_HOOK_MODES[event];
  return mode ? `"${leaseScriptPath(logDir)}" ${mode}` : undefined;
}

/**
 * POSIX sh (macOS `/bin/sh`), with `plutil` to read the JSON payload — a
 * command can hold any quoting, which a `sed` capture would get wrong — and
 * `md5` for the qualifier, so the core computes the same one with `crypto`.
 *
 * `holder.json` is one line written by either side, read back here with a
 * `sed` anchored on `{` or `,` before the key, so a key name inside a quoted
 * value (escaped as `\"`) can never match.
 */
export function leaseScript(): string {
  return `#!/bin/sh
# Agent Wrangler lease hook, v${LEASE_SCRIPT_VERSION}. Installed by Agent Wrangler with its status hooks.
# Serialises tool calls that need an exclusive resource (leases/resources.tsv).
# Waits a bounded time for a lease held by another session, then denies with a
# reason. Never prints "allow": a granted lease only lets the normal flow run.
dir=$(dirname "$0")
L="$dir/${LEASES_DIR_NAME}"
R="$L/${RESOURCES_FILE_NAME}"
mode="$1"
payload=$(cat)
tab=$(printf '\\t')
nl='
'
if [ "$mode" = pre ]; then
  [ -s "$R" ] || exit 0
else
  set -- "$L"/*/holder.json
  [ -f "$1" ] || exit 0
fi

field() { printf '%s' "$payload" | /usr/bin/plutil -extract "$1" raw -o - - 2>/dev/null; }
hstr() { sed -n "s/.*[{,]\\"$1\\":\\"\\([^\\"]*\\)\\".*/\\1/p" "$2" 2>/dev/null | head -n 1; }
hnum() { sed -n "s/.*[{,]\\"$1\\":\\([0-9][0-9]*\\).*/\\1/p" "$2" 2>/dev/null | head -n 1; }
jesc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g' | tr -d '\\n\\r\\t'; }
lstart() { TZ=UTC LC_ALL=C LANG=C ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//; s/ *$//'; }
old() { [ -n "$(find "$1" -prune -mmin +1 2>/dev/null)" ]; }
note() { printf '{"hook_event_name":"%s","session_id":"%s","lease":"%s"%s}\\n' "$1" "$sid" "$(jesc "$2")" "$3" >> "$dir/$PPID.jsonl"; }

# A lease is live while its holder process is: same pid, same start time.
# A lease with no holder.json yet is being created, unless it is old. One held
# for an orchestrated attempt is the core's to judge while the core keeps it
# fresh, so a core restart does not hand it to someone else.
alive() {
  ah="$1/holder.json"
  if [ ! -f "$ah" ]; then old "$1" && return 1; return 0; fi
  if grep -q '"attemptId"' "$ah" 2>/dev/null && [ -z "$(find "$ah" -mmin +${ATTEMPT_HEARTBEAT_MINUTES} 2>/dev/null)" ]; then return 0; fi
  ap=$(hnum pid "$ah")
  [ -n "$ap" ] || return 1
  kill -0 "$ap" 2>/dev/null || return 1
  as=$(hstr pidStart "$ah")
  [ -z "$as" ] || [ "$(lstart "$ap")" = "$as" ]
}

# Remove a stale lease under its .reap lock, re-checked under the lock: nobody
# can replace a lease while it exists, so the check cannot be overtaken.
reap() {
  if mkdir "$1.reap" 2>/dev/null; then
    if [ -d "$1" ] && ! alive "$1"; then rm -rf "$1"; fi
    rmdir "$1.reap" 2>/dev/null
  elif old "$1.reap"; then
    rm -rf "$1.reap"
  fi
}

sid=$(field session_id)
[ -n "$sid" ] || exit 0

empty_uses() { [ -z "$(ls -A "$1/uses" 2>/dev/null)" ]; }
release() { rm -rf "$1" && note ${LEASE_RELEASED_EVENT} "$(basename "$1")" ""; }

if [ "$mode" = post ]; then
  tuid=$(field tool_use_id)
  for h in "$L"/*/holder.json; do
    [ -f "$h" ] || continue
    d=$(dirname "$h")
    [ -n "$tuid" ] && rm -f "$d/uses/$tuid"
    [ "$(hstr sessionId "$h")" = "$sid" ] || continue
    [ "$(hstr scope "$h")" = command ] || continue
    empty_uses "$d" && release "$d"
  done
  exit 0
fi

if [ "$mode" = stop ]; then
  for h in "$L"/*/holder.json; do
    [ -f "$h" ] || continue
    d=$(dirname "$h")
    [ "$(hstr sessionId "$h")" = "$sid" ] || continue
    # The turn is over, so no call of it is still running: a command lease left
    # behind is one whose call never ran (interrupted, or denied by something
    # that fires no hook), and goes too.
    case "$(hstr scope "$h")" in
      turn|command) release "$d" ;;
    esac
  done
  exit 0
fi

[ "$mode" = pre ] || exit 0
tool=$(field tool_name)
cmd=""
[ "$tool" = Bash ] && cmd=$(field tool_input.command)

# Every resource the call needs, once each, in the file's (key) order.
want=""
seen=" "
while IFS="$tab" read -r key keyby scope wait kind pat label; do
  [ -n "$pat" ] || continue
  case "$seen" in *" $key "*) continue ;; esac
  case "$kind" in
    tool) printf '%s\\n' "$tool" | grep -Eq -- "$pat" || continue ;;
    bash) [ "$tool" = Bash ] || continue; printf '%s\\n' "$cmd" | grep -Eq -- "$pat" || continue ;;
    *) continue ;;
  esac
  seen="$seen$key "
  want="$want$key$tab$keyby$tab$scope$tab$wait$tab$label$nl"
done < "$R"
[ -n "$want" ] || exit 0

deny() {
  for g in $got; do rm -rf "$L/$g"; done
  for u in $used; do rm -f "$L/$u"; done
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "$(jesc "$1")"
  exit 0
}

if [ "$tool" = Bash ] && [ "$(field tool_input.run_in_background)" = true ]; then
  first=$(printf '%s' "$want" | head -n 1 | cut -f 5)
  deny "Run commands that use $first in the foreground, so the lease ends when they do."
fi

mkdir -p "$L" 2>/dev/null || exit 0
tuid=$(field tool_use_id)
[ -n "$tuid" ] || tuid="pid-$$"
cwd=$(field cwd)
[ -n "$cwd" ] || cwd=$(pwd)
got=""
used=""

# Record this call on a command lease. Fails when the lease has just been
# released (never recreate its directory without a holder): acquire again.
use() {
  [ "$2" = command ] || return 0
  mkdir "$L/$1/uses" 2>/dev/null
  [ -f "$L/$1/holder.json" ] || return 1
  : > "$L/$1/uses/$tuid" && used="$used $1/uses/$tuid"
}

# One deadline for the whole call, however many leases it needs: the hook's
# own timeout is for all of them.
started=$(date +%s)

while IFS="$tab" read -r key keyby scope wait label; do
  [ -n "$key" ] || continue
  q=""
  case "$keyby" in
    repo)
      g=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
      [ -n "$g" ] || g="$cwd"
      q=$(md5 -qs "$g" | cut -c1-12) ;;
    cwd) q=$(md5 -qs "$cwd" | cut -c1-12) ;;
  esac
  lk="$key"
  [ -n "$q" ] && lk="$key@$q"
  d="$L/$lk"
  end=$(( started + wait ))
  waiting=""
  while :; do
    if mkdir "$d" 2>/dev/null; then
      printf '{"v":1,"resource":"%s","sessionId":"%s","pid":%s,"pidStart":"%s","scope":"%s","since":%s000,"label":"%s","cwd":"%s"}\\n' \\
        "$key" "$sid" "$PPID" "$(lstart "$PPID")" "$scope" "$(date +%s)" "$(jesc "$label")" "$(jesc "$cwd")" > "$d/holder.json.$$" &&
        mv "$d/holder.json.$$" "$d/holder.json"
      got="$got $lk"
      use "$lk" "$scope"
      note ${LEASE_ACQUIRED_EVENT} "$lk" ",\\"resource\\":\\"$key\\""
      break
    fi
    h="$d/holder.json"
    hs=$(hstr sessionId "$h")
    if [ "$hs" = "$sid" ]; then
      use "$lk" "$(hstr scope "$h")" && break
      continue
    fi
    if [ -d "$d" ] && ! alive "$d"; then
      reap "$d"
      [ -d "$d" ] || continue
    fi
    if [ -z "$waiting" ]; then
      # A cancel can only be meant for a wait that has started.
      waiting=1
      rm -f "$L/${CANCEL_DIR_NAME}/$sid"
      note ${LEASE_WAITING_EVENT} "$lk" ",\\"resource\\":\\"$key\\",\\"holder_session_id\\":\\"$hs\\""
    elif [ -e "$L/${CANCEL_DIR_NAME}/$sid" ]; then
      rm -f "$L/${CANCEL_DIR_NAME}/$sid"
      note ${LEASE_DENIED_EVENT} "$lk" ",\\"reason\\":\\"cancelled\\""
      deny "Stopped waiting for $label: the user cancelled the wait. Do other work, or ask the user."
    fi
    now=$(date +%s)
    if [ "$now" -ge "$end" ]; then
      since=$(hnum since "$h")
      for_=""
      if [ -n "$since" ]; then
        min=$(( (now - ${'$'}{since%???}) / 60 ))
        if [ "$min" -lt 1 ]; then for_=" (for under a minute)"; else for_=" (for $min min)"; fi
      fi
      note ${LEASE_DENIED_EVENT} "$lk" ",\\"holder_session_id\\":\\"$hs\\""
      deny "$label is in use by another agent session$for_. Do other work and try again later, or ask the user."
    fi
    sleep 0.5
  done
done <<EOF
$want
EOF
exit 0
`;
}

export async function leaseScriptCurrent(logDir: string): Promise<boolean> {
  try {
    return (await fsp.readFile(leaseScriptPath(logDir), 'utf8')) === leaseScript();
  } catch {
    return false;
  }
}

/** Write the script (tmp + rename, executable). */
export async function writeLeaseScript(logDir: string): Promise<void> {
  const target = leaseScriptPath(logDir);
  const tmp = `${target}.tmp`;
  await fsp.mkdir(logDir, { recursive: true });
  await fsp.writeFile(tmp, leaseScript(), { encoding: 'utf8', mode: 0o755 });
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, target);
}

/**
 * Bring an installed lease script up to this version, never installing one
 * and never downgrading one a newer build wrote. True if it changed.
 */
export async function refreshLeaseScript(logDir: string): Promise<boolean> {
  let text: string;
  try {
    text = await fsp.readFile(leaseScriptPath(logDir), 'utf8');
  } catch {
    return false;
  }
  if (text === leaseScript()) return false;
  const installed = Number(/lease hook, v(\d+)\./.exec(text)?.[1] ?? 0);
  if (installed > LEASE_SCRIPT_VERSION) return false;
  await writeLeaseScript(logDir);
  return true;
}
