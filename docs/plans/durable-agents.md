# Durable agents (#179)

An **agent** is a durable, configured identity. A **session** is one runtime conversation.
A **mission** is a delegated outcome. This plan records what shipped in each slice and what
was decided along the way.

## Decisions

| Open question (#179) | Decision |
|---|---|
| 1. How does continuity memory update? | Explicit remember/forget by the user, plus updates the agent proposes for the user to approve. Nothing is written silently. (2026-10-14) |
| 2. One conversation or named threads? | One canonical conversation per agent in v1, plus a history of earlier ones. Named threads come later. (2026-10-14) |
| 3. Instruction sources | Inline text, plus optionally one file inside the agent's project folder (for example `docs/agents/po.md`). The file is read afresh at every launch and resume, so an edit to it reaches the next conversation. A missing or unreadable file is reported when you send, never skipped. Global agents have inline text only. (2026-10-15) |
| 4. Scope | Global, or one project folder. Multi-repository scope comes later. (2026-10-14) |
| 5. Editing once conversations exist | Every field stays editable and applies from the next message. Changing the harness or the folder cannot continue the current conversation: the app asks first, then moves it to history, and the next message starts a new one. Memory carries over. (2026-10-15) |
| 6. Route compatibility | `#/` and the new `#/sessions` open Sessions. `#/agents` is the new Agents directory. The app never wrote `#/agents` before, so no existing link changes meaning. (2026-10-14) |
| 7. Ordering | Pin and archive. Pinned agents come first, then most recently used. Archived agents are hidden behind *Show archived* and can be restored; they still open from a link. No manual drag order or grouping. (2026-10-15) |

## Slices 1 to 4 (b958692)

- **Vocabulary and routes.** `appRoutes.ts` has `agents` and `sessions` routes. The bar reads
  Agents | Sessions | Missions | Analytics | Preferences | Connect. Missions now has its own
  link and hides when orchestration is off, as Analytics does.
- **Domain and store.** `shared/durableAgents.ts` holds the model, validation, linking and the
  open plan; it is pure and tested. `core/durableAgentStore.ts` keeps the agents in the
  app's `state.json` under `agentWrangler.durableAgents`.
- **Agents directory.** This is the table pane's `agents` view (`webview/dashboard/agents.ts`).
  Every layout rule is scoped to the pane.
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

## Slice 5: continuity memory (#180)

- **The record** (`shared/agentMemory.ts`). A short list of items, each a decision, a
  preference, an open question or current work. Each item is at most 500 characters and the
  whole record at most 4,000, checked when an item is written. What a conversation is sent is
  the record as the user sees it, never a quietly cut copy.
- **The user's controls.** In Agents, *Memory* under an agent's card lists the items to edit
  or forget, the box to remember a new one, and the characters used. In the conversation pane,
  a strip under the header (folded to one line) shows the memory of the agent the
  conversation belongs to, with *Forget* and *Remember*. Every change is `agent.write`.
- **The agent's proposals.** The agent runs `aw remember --kind <kind> "<line>"` or
  `aw forget <id>` in its shell (control method `agent.propose`, action `agent.propose`). The
  conversation it runs in (`CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`) names the agent.
  The proposal is stored as pending only: a card at the end of the conversation and in
  Agents, with *Approve* and *Reject*. Approving is the user's `agent.write`; an approval
  that no longer fits the cap is refused and the proposal stays. At most 10 proposals wait
  per agent. The origin is self-reported, so a process could put a card on another agent;
  it still stores nothing without the user.
- **Injection.** The record is appended to the agent's instructions, grouped by kind with
  each item's id, framed as context and never permission. It is sent at launch, and at every
  resume: a resumed conversation (Claude `claudeLaunch`, Codex `adoptCodexSession`) gets the
  instructions, file and memory of the agent that *holds* it now, not the copy frozen at
  launch. An assigned session speaks as its new agent; one unassigned from the agent that
  launched it resumes with the plain conversation guidance and no agent's memory. A resume nobody asked for (after a restart) falls back to the launch copy if the
  instructions file cannot be read, and logs why.
- **Boundaries.** Memory never grants permissions, changes policy or starts delegated work;
  the instructions say so, and `aw remember` can only propose.

## Slice 6: history and linkage (#181)

- **History.** *History* under an agent's card lists its earlier conversations (title, status,
  age), newest first. *Open* shows one through the row-click path; *Make current* makes it the
  conversation typing to the agent continues, and the current one moves to history.
- **Sessions.** A row's chip names its agent: solid for the current conversation, dashed
  "· earlier" for one in history. The row menu offers *Assign to <agent>* (agents of the same
  harness whose folder contains the session's, or any Global agent; not archived; at most
  five) and *Unassign from <agent>*. Both are `agent.write`, audited with the agent id or
  the session key.
- **One agent per session.** Assigning takes the session off any other agent. Unassigning
  records the id in the agent's `detached` list, because the session's origin still names
  the agent and a resume of it would otherwise be taken for the agent's conversation
  continuing. The watcher also skips any id another agent holds.
- **Make current** refuses a conversation the agent can no longer carry on (another harness or
  folder, left in history by an edit).
- **Codex resumes on type.** Typing to an agent's current Codex thread that is stopped
  resumes it here, as Claude does. Any other Codex thread still needs *Take over here*. A
  forked thread (the original still open in VS Code) is linked as the agent's conversation
  continued.

## Slice 7: configure flow (#182)

- **Instructions file.** See decision 3. The form checks the file exists when you save; the
  launch and every resume read it again. The file must resolve inside the project folder
  (symlinks included) and be at most 16,000 characters.
- **Editing.** See decision 5. The form says what applies when.
- **Pin and archive.** See decision 7. Archiving unpins.

## Known limits

- Typing to an agent's *earlier* conversation resumes it like any session; a Claude resume
  under a new id may then become the agent's current conversation (the follow watcher treats
  an unknown id on an agent-origin handle as a continuation).
- Proposals are shown to the user but the agent is not told the outcome.
- Named threads and multi-repository scope are not built.
