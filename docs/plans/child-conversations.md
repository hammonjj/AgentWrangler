# Child conversations (#198)

A durable agent's conversation spawns ordinary Claude or Codex conversations, each in its own
git worktree and branch, and drives, merges and finishes them itself. It replaces missions as the
way a durable agent hands work off. Missions stay until #199 removes them; nothing here depends
on them.

## Design

| Piece | Where | What it does |
|---|---|---|
| Parent link | registry `origin` `{kind: 'child', agentId, childId, parent, worktree, branch, repo}` (`src/shared/childConversations.ts`) | Carried across resumes and id changes like any origin. Names the agent by its stable id; the parent row is the agent's **current** conversation, so Claude id changes on either side do not break the link. `childId` (the worktree slug) is stable for the child's life. |
| Worktree | `src/core/childWorktree.ts` | `<repoParent>/<repo>-child-<slug>` on `child/<slug>`, cut from the HEAD of the git toplevel of the calling conversation's folder (or `--folder`). `node_modules` linked when the checkout has one. Never the mission layout (`<repo>.aw/…`, `aw/…`). Standalone: `src/orchestration` goes in #199. |
| App logic | `src/app/childConversations.ts` | Resolves the caller and the target, spawns (`sessions.launch(launchDefaults.request(…))`, then sends the prompt), sends (resuming an idle child as typing does), reads, stops, finishes. |
| Access | `child.spawn`, `child.send`, `child.read`, `child.stop`, `child.done` in `ACTIONS` and `AGENT_ACTIONS` (`src/core/access.ts`) | Asked as `agent:<agentId>`. `authorize` checks the target: `child.spawn` / the list name the agent itself; everything else a session whose `ResourceRef.agentId` (the child's origin agent) is the caller's. |
| Wire | `child.spawn`, `child.list`, `child.send`, `child.read`, `child.stop`, `child.done` (`src/core/control/protocol.ts`) | Each needs the caller's `origin` (`CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`). Spawn, send, stop and done are mutating (refused while quitting, logged without content). |
| CLI | `aw child spawn|list|read|send|stop|done` | Not in `agentShellRefusal`: meant for an agent's shell, scoped by the core. |
| Table | `childOf` on the session DTO (`DashboardHost`), `nestChildren` / `childNeedsYou` | Children render indented under the parent row, foldable (saved per agent id); a folded parent shows *child needs you*. A child whose parent is not shown is an ordinary row. |
| Agents page | `DurableAgentView.children` | Unfinished children listed under the agent, each opening its conversation. |
| Guidance | `CHILD_CONVERSATION_GUIDANCE`, `childInstructions` | Durable agents get the `aw child` guidance instead of the `aw delegate` guidance, at launch and every resume. A child is told its branch, to commit and not merge, and that it cannot spawn, at launch and every resume. |

## Rules

| Rule | Enforced by |
|---|---|
| Only a durable agent's conversation (current or earlier, `holderOf`) may spawn or act | `childCallerDecision`, before anything resolves |
| One level: a child cannot spawn or act | `childCallerDecision` (its own origin is a child), and a child is never held by an agent |
| An agent acts only on its own children; any other session is refused, CLI or not | `authorize` with the agent principal and the target's child owner |
| A child is never the agent's conversation | child origin is not `{kind: 'agent'}` (so `follow()` ignores it); `assign` refuses a child; the row menu offers no Assign |
| The parent merges the child's branch itself | guidance only; nothing merges for it |
| `done` refuses on a dirty tree, an unmerged branch (against the default branch: origin HEAD, else `main`, else `master`) or a working child, unless `--discard` | `doneDecision` |
| A worktree is never removed with `--force`; a discard resets and cleans it first; an unmerged branch is kept, a merged one deleted with `git branch -d` | `removeChildWorktree` |
| A child interrupted by a restart resumes like any conversation | `autoResumeCandidate` treats `child` (and any unknown kind) as ordinary |

## Not done here

- Reading an idle child's transcript when Agent Wrangler does not run it: `aw child read` shows
  recent blocks from the live handle only, and says so otherwise.
- Per-child model or effort: children use the launcher's defaults.
