---
name: agentwrangler-task
description: Hand a piece of work from this conversation to an Agent Wrangler task with `aw task`, which routes it to a suitable model and effort and runs it in its own worktree once the user approves. Use when the user says "run this as a task", "make this a task", "hand this off", "send this to a task", "have a task do it", "route this", or "task it". Also use when they ask for work to be done "in the background" or "by a cheaper model" while they keep talking to you.
---

# Hand work to an Agent Wrangler task

Agent Wrangler can run a piece of work as a **task**. It assesses the work, proposes a model and
effort, and, once the user accepts, runs it in a fresh git worktree and branch, then checks the
result. `aw task` creates the proposal. **Nothing runs until the user approves it in the app**, so
you never start work on their behalf.

## When

- The user asks for it (see the description's phrases). Don't hand work off unasked.
- Also offer it, in one line, when they describe a well-bounded change they clearly don't need
  to watch ("just fix X", "someone should add tests for Y"). Don't run it until they say yes.

## How

1. Turn the request into a **self-contained objective**. The task agent starts cold and does not
   see this conversation. Include what to change, where (files, functions, commands), why, and
   any decisions already made here. A few short paragraphs is fine.
2. Write **acceptance criteria**: short, checkable statements, separated by semicolons, e.g.
   `npm test passes; the parser rejects empty input with a clear error; no new dependencies`.
   Without them the router treats the task as ambiguous and the reviewer has nothing to check.
3. Run it from inside the repository (or pass `--folder <repo>`). Pass a long objective on stdin:

   ```bash
   aw task - --criteria "first criterion; second criterion" <<'EOF'
   <the objective>
   EOF
   ```

   For a one-liner: `aw task "Add a --json flag to aw tasks" --criteria "npm test passes"`.
   `--claude` / `--codex` sets which agent to prefer. The default is the one running this shell.
4. Tell the user what `aw task` printed: the proposed route, and that it is waiting for them
   (the *Task proposal* notification, or the launcher's **Tasks** menu). Then carry on with the
   conversation. Don't wait for the task.

`aw tasks` lists unfinished tasks and their state, if the user asks how one is going.

## If it fails

| Output | Meaning |
|---|---|
| `Agent Wrangler is not running` | Ask the user to open the app. |
| `Tasks are off…` | Orchestration is disabled. Tell the user to set `"orchestration.enabled": true` in the app's settings.json. |
| `… is not in a git repository` | Pass `--folder` with the repository's path. |
| `command not found: aw` | The user runs `npm run cli:install` in the Agent Wrangler checkout. |

Don't retry in a loop, and don't fall back to doing the work yourself unless the user asks.

## Notes

- The task's branch is cut from the repository's primary checkout (its `HEAD`), not from your
  worktree. If the work depends on uncommitted or unmerged changes here, say so to the user first.
- The task agent can't push or merge. The user reviews its branch and merges it.
