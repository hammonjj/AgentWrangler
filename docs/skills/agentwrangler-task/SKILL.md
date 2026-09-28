---
name: agentwrangler-task
description: Delegate a piece of work from this conversation to Agent Wrangler with `aw delegate`, which has a read-only planner decide whether it is one task or several, routes it to a suitable model and effort, and runs it in its own worktree once the user approves. Use when the user says "delegate this", "hand this off", "run this as a task", "make this a task", "send this to a task", "have a task do it", "route this", or "task it". Also use when they ask for work to be done "in the background" or "by a cheaper model" while they keep talking to you.
---

# Delegate work to Agent Wrangler

Agent Wrangler can take work off this conversation. You hand over the **outcome**. A read-only
planner reads the repository and decides whether it is **one task** or **a plan of several**
(it prefers one). Agent Wrangler then proposes a model and effort for the task, or lays out the
plan. Once the user approves, it runs the work in its own git worktree and branch, and checks
the result. `aw delegate` only creates the proposal. **Nothing runs until the user approves it
in the app**, so you never start work on their behalf. This conversation is only where the
proposal is shown. The work runs in sessions of its own and does not come back here.

## When

- The user asks for it (see the description's phrases). Don't hand work off unasked.
- Also offer it, in one line, when they describe a well-bounded change they clearly don't need
  to watch ("just fix X", "someone should add tests for Y"). Don't run it until they say yes.
- You don't have to decide how big it is: that is the planner's job.

## How

1. Turn the request into a **self-contained objective**. The agents that do the work start cold
   and do not see this conversation. Say what to change, where (files, functions, commands),
   why, and any decisions already made here. A few short paragraphs is fine.
2. Write **acceptance criteria**: short, checkable statements for the whole outcome, separated
   by semicolons, e.g.
   `npm test passes; the parser rejects empty input with a clear error; no new dependencies`.
   Without them the router treats the work as ambiguous and the reviewer has nothing to check.
3. Run it from inside the repository (or pass `--folder <repo>`). Pass a long objective on stdin:

   ```bash
   aw delegate - --criteria "first criterion; second criterion" <<'EOF'
   <the objective>
   EOF
   ```

   For a one-liner: `aw delegate "Add a --json flag to aw tasks" --criteria "npm test passes"`.
   `--claude` / `--codex` sets which agent to prefer. The default is the one running this shell.
   It can take a minute or two while the planner reads the repository.
4. Tell the user what `aw delegate` printed: the decision (one task and its proposed route, or a
   plan and its tasks), and that it is waiting for them on the *Delegated* card at the end of
   this conversation in Agent Wrangler. There they can run it, change the model or effort,
   approve the plan, edit it in Missions, or cancel. If it printed that the planner is still
   deciding, say the card will show the decision. Then carry on with the conversation. Don't
   wait for the work.

`aw tasks` lists unfinished tasks and their state, if the user asks how one is going.

`aw task` (same options) is a shortcut for when the user explicitly wants **one task** and no
planner. Prefer `aw delegate` otherwise.

## If it fails

| Output | Meaning |
|---|---|
| `Agent Wrangler is not running` | Ask the user to open the app. |
| `Delegating is off…` / `Tasks are off…` | Orchestration is disabled. Tell the user to set `"orchestration.enabled": true` in the app's settings.json. |
| `… is not in a git repository` | Pass `--folder` with the repository's path. |
| `aw: no command "delegate"` or `no method delegate` | The installed app predates Delegate. Use `aw task` instead, and tell the user to update. |
| `command not found: aw` | The user runs `npm run cli:install` in the Agent Wrangler checkout. |

Don't retry in a loop, and don't fall back to doing the work yourself unless the user asks.

## Notes

- The work's branch is cut from the repository's primary checkout (its `HEAD`), not from your
  worktree. If it depends on uncommitted or unmerged changes here, say so to the user first.
- The agents doing the work can't push or merge. The user reviews the result and merges it.
