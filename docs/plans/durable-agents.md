# Durable agents (#179)

An **agent** is a durable, configured identity. A **session** is one runtime conversation.
A **mission** is a delegated outcome. This plan records what shipped in the first slices and
what was decided for the rest.

## Decisions (2026-10-14)

| Open question (#179) | Decision |
|---|---|
| 1. How does continuity memory update? | Explicit remember/forget by the user, plus updates the agent proposes for the user to approve. Nothing is written silently. |
| 2. One conversation or named threads? | One canonical conversation per agent in v1, plus a history of earlier ones. Named threads come later. |
| 4. Scope | Global, or one project folder. Multi-repository scope comes later. |
| 6. Route compatibility | `#/` and the new `#/sessions` open Sessions. `#/agents` is the new Agents directory. The app never wrote `#/agents` before, so no existing link changes meaning. |

## What shipped: slices 1 to 4

- **Vocabulary and routes.** `appRoutes.ts` has `agents` and `sessions` routes. The bar reads
  Agents | Sessions | Missions | Analytics | Preferences | Connect. Missions now has its own
  link and hides when orchestration is off, as Analytics does.
- **Domain and store.** `shared/durableAgents.ts` holds the model, validation, linking and the
  open plan; it is pure and tested. `core/durableAgentStore.ts` keeps the agents in the
  app's `state.json` under `agentWrangler.durableAgents`.
- **Agents directory.** This is the table pane's `agents` view (`webview/dashboard/agents.ts`).
  It shows a list, a create/edit form and the actions *New conversation*, *Edit* and
  *Delete*. Every layout rule is scoped to the pane.
- **Launch and resume** (`app/durableAgents.ts`). The open plan works like this:
  - An agent with a current session that is known or live opens that session.
  - Otherwise the pane shows an empty conversation keyed `agent:<id>`
    (`ui/conversation/agentDraftSource.ts`), and the first message launches a session.
  - If the current session is lost, the pane says so. It never shows another conversation
    in its place.
  - A launched session gets the agent's harness, model and effort, and the agent's
    instructions plus the delegation guidance as appended system prompt (Claude) or
    developer instructions (Codex).
  - A launched session gets the origin `{kind: 'agent', agentId}`. The registry keeps it
    across resumes, so a continuation under a new session id stays linked to the agent.
  - Opening an agent is `session.open`. Its first message is `session.start`. Create, edit,
    delete and *New conversation* are a new `agent.write` action.
- **Linkage.** Sessions shows a chip with the agent's name on the agent's current
  conversation. Sessions started anywhere else stay unassigned.

## Known limits

- A stopped **Codex** current conversation opens read-only with *Take over here*, as any Codex
  thread does. Claude resumes when you type.
- The instruction source is text held by Agent Wrangler. File-backed instruction sources
  (open question 3) are not built.
- After an edit that changes the harness or the folder, the next message starts a new
  conversation. The previous one moves to history (open question 5).
- There is no ordering, pinning or archiving of agents yet (open question 7). The list is
  most recently used first.

## Remaining slices

- **5. Continuity memory.** An editable "where we left off" record, remember/forget controls,
  proposed updates the user approves, and bounded injection at launch.
- **6. History and linkage.** Browse an agent's earlier conversations, and assign or unassign
  a session by hand.
- **7. Configure flow.** File-backed instruction sources, ordering, pinning and archiving.
