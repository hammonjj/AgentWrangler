# Scoped agent mission control

Date: 2026-10-25. Design chosen by the user: the **scoped grant** (2026-10-25). Builds on the
delegation ownership contract (`docs/plans/delegation-ownership-contract.md`, `Mission.origin`),
the status contract (`docs/plans/status-contract.md`, C1–C3) and the access boundary
(`src/core/access.ts`, #123).

## 1. The problem

A product-owner agent can delegate many missions (`aw delegate`). Each one that finishes waits on
the user: **Accept**, then a finish choice. The user clicked Accept on dozens of them. Accepting
only marks the task accepted: a single-task mission then sits in review, labelled
"accepted — branch kept", with nothing merged. The agent that delegated the work could not even
see where its missions were, because `aw tasks` printed one line per task and nothing else.

`aw send`, `aw stop` and `aw web url|pair|devices revoke` refuse in an agent's shell
(`agentShellRefusal`, `src/cli/args.ts`). That protects against a prompt-injected agent driving
other sessions. It stays exactly as it is for everything outside this feature.

## 2. What was built

| Part | What it does | Where |
|---|---|---|
| Read-only views | `aw missions [--all] [--mine]` and `aw mission <id>`: state, each task's state, verification checks and their outcomes, branch, diff stat against the base, and what the mission waits on | `src/shared/orchestration/missionGrant.ts` (`missionInspection`, `missionWait`), `src/cli/format.ts` |
| The grant | One switch per durable agent, **off by default**, in Preferences → Agents and status → Agent mission control | `src/app/missionGrants.ts`, `src/webview/preferences/missionGrants.ts` |
| The guarded acts | `aw mission accept <id> [--task <key>] [--finish <how>]`, `aw mission finish <id> <how>`, `aw mission cancel <id>`, from inside the agent's own conversation | `src/cli/args.ts`, `src/app/controlBackend.ts` (`missionAct`) |
| The merge confirmation | `merge-local` asked by an agent becomes a request. The user answers it with **Confirm merge** or **Decline** in Missions | `src/app/approvals.ts` (`createMissionConfirmations`) |
| The audit | Every act, refusal, request and answer, listed under the mission in Missions (*Agent activity*), and in the access audit log | `MissionGrantAuditEntry`, `agentActivityOf` |

"What it waits on" is one of: `needs-you`, `route-proposed`, `plan-proposal`, `attempt-failed`,
`ready-for-review`, `merge-confirmation`, `working`, `nothing`. The list may grow; a reader shows
an unknown kind's text.

## 3. The rules

A granted agent may accept, finish or cancel a mission only when **all** of these hold. They are
checked in this order, and the first one that fails is the reason given:

| # | Rule | Refusal code |
|---|---|---|
| 1 | The conversation asking belongs to a durable agent (`DurableAgentStore.holderOf`) | `not-an-agent` |
| 2 | That agent's grant is on | `grant-off` |
| 3 | The mission's `origin` conversation belongs to **the same** agent | `wrong-origin` |
| 4 | The act fits the mission now: a finished attempt to accept, a mission in review to finish, a mission not yet ended to cancel, no finish under way | `not-available` |
| 5 | The task (for accept) passed its checks (`summariseVerification` is `passed`), or the whole mission (for finish and cancel) is `verified` (`missionVerification`). `unverified` never qualifies, including "no checks configured" | `unverified` |

Then:

- `pull-request`, `keep` and `discard` run at once, as the Missions page's own buttons do
  (`TaskRunner.finishMission`).
- `merge-local` **never** runs on the agent's word. It records a `MissionConfirmationRequest`, a
  notification says so, and the mission shows *Merge requested* with **Confirm merge** and
  **Decline**. One pending request per mission: asking again joins it.
- `accept --finish <how>` accepts and then applies the finish in the same guarded step, so an
  accepted single task does not sit in review unmerged. In a planned mission with tasks still to
  run, the accept stands and the finish waits until the mission is ready for review.

Turning a grant off withdraws that agent's unanswered merge requests.

## 4. One path, through `authorize()`

```
aw mission finish <id> merge-local          (agent's shell; origin from CLAUDE_CODE_SESSION_ID / CODEX_THREAD_ID)
  → control socket `mission.act`             (shape checked: act, how, origin required)
  → controlBackend.missionAct
      → callerOf(origin): the durable agent, or refuse
      → gate.admit(agentContext(agentId), 'mission.agent', {kind:'mission', id})   ← authorize() + access audit
      → missionGrants.act → grantDecision (§3) → audit → runner, or a merge request
  Missions page: Confirm merge
  → dashboard message `mission` {op: agent-request}
  → gate.admit(owner, 'mission.act', mission)                                       ← authorize() + access audit
  → missionGrants.confirm → approvals.ts createMissionConfirmations
      → settle first (a second Confirm from any client is `stale`), recheck, finishMission
```

- `src/core/access.ts` has a second principal kind, `agent` (`agent:<agentId>`). `authorize()`
  allows it `view.read` and `mission.agent` (`AGENT_ACTIONS`) and **nothing else**: no
  `session.send`, no `mission.act`, no `settings.write`. A principal whose id does not match its
  agent id is denied.
- `mission.grant` (the owner's Preferences switch) and `mission.agent` are new actions. Both are
  `mutate`, so both are audited allowed or refused.
- `authorize()` decides who may ask for what. `grantDecision` decides, per mission, whether this
  agent may ask about this mission. The dispatcher calls both, in that order.
- The confirmation is answered in `src/app/approvals.ts`, next to the permission, question and
  plan answers, with the same "already answered" rule.

## 5. Threat model

- **Identity is the conversation's own environment.** `aw` reads `CLAUDE_CODE_SESSION_ID` or
  `CODEX_THREAD_ID`, as `aw delegate` and `aw remember` already do. A same-user process can
  claim another session id, as it can read the control token
  (`docs/plans/session-lifecycle-architecture.md` §12). This is the same speed bump as the
  existing refusals, not a wall. What a forged claim gets is bounded: only missions that agent
  delegated, only verified ones, and never a merge to the base without the user's click.
- **No worker gains authority.** Task attempts run in their own sessions; their origin is
  orchestration, not a durable agent, so rule 1 refuses them.
- **Nothing is merged unverified, and nothing is merged unconfirmed.** Rule 5 and the
  confirmation are both re-checked at the moment of the answer, not at the moment of the ask.
- **The audit holds ids, agent names, act names and our own refusal text.** Never prompts,
  objectives or paths.

## 6. Investigated, not changed: why tasks show `checks ? unverified`

| Finding | Evidence |
|---|---|
| A task's checks come only from the repository's policy file, `repos/<repo-id>.json` in Agent Wrangler's support folder. Without one, `DEFAULT_REPO_POLICY` has no verification commands. | `repoPolicy.ts` `DEFAULT_REPO_POLICY`, `repoPolicyStore.ts` |
| With no commands, a task's plan is at most `diff-sanity` (plus an advisory review). Neither counts as verifying: `summariseVerification` requires a required `command:*` (or `regression-test`) stage that passed. So the result is `unverified`, shown as `? unverified` (and "no checks configured" in the outcome). | `verification.ts` `verifies`, `summariseVerification` |
| A passing required **review** stage still leaves the task `unverified`, by design: a reviewer's opinion is not a check. | `verification.ts` `verifies` |
| The plan is frozen on the task when it is created (#35). Adding a policy later fixes new tasks only. | `taskRunner.ts` `propose` |
| On this Mac only the Agent Wrangler repository has a policy file. A Unity project (the product-owner agent's) has none, so every one of its tasks is `unverified`. | the support folder's `repos/` |

**Can a mission declare its own checks?** Not today, on purpose: "the policy is user-authored. A
model may reference a verification command by name, but nothing a model produces is ever parsed
as a policy" (`repoPolicy.ts`). `aw delegate --criteria` gives acceptance criteria for the
reviewer, which do not verify. A planner may only narrow to commands the policy already names.
Letting an agent's mission add a command would let an agent choose what runs on the Mac and what
counts as passing, which is exactly what the grant must not depend on.

**What clears it** is a policy file written by the user, for example for a Unity project
(argv, never a shell string; batch mode, no graphics, so no audio plays):

```json
{
  "v": 1,
  "verification": {
    "editmode": {
      "run": ["/Applications/Unity/Hub/Editor/<version>/Unity.app/Contents/MacOS/Unity",
              "-batchmode", "-nographics", "-projectPath", ".", "-runTests",
              "-testPlatform", "EditMode", "-testResults", "test-results.xml", "-logFile", "-"],
      "timeoutSec": 1800
    },
    "missionDefault": ["editmode"]
  },
  "exclusive": [{ "id": "unity-editor:<project>", "why": "one Unity editor per project at a time" }]
}
```

Options for later (not built; the user decides):

| Option | Effect | Risk |
|---|---|---|
| A Preferences page for repository policies (already planned in the README) | The user adds checks without editing JSON | None new |
| `aw delegate --check <name>` | An agent narrows a mission to commands the policy already defines | None new: it can only pick from the user's list |
| Missions allowed to add commands | Clears `unverified` without the user | An agent decides what "verified" means. Not recommended |

## 7. Tests

`test/orchestration/missionGrant.test.ts` (grant off, grant on, wrong origin, unverified, merge
needs confirmation, two clients confirming at once, decline, withdrawal, audit, the Missions
page's buttons, the agent principal in `authorize()`), `test/awMissions.test.ts` (parsing, the
unchanged agent-shell refusals, printing), and additions to `test/access.test.ts`,
`test/controlSocket.test.ts` and `test/preferencesHost.test.ts`.

## 8. Open

- Discord and the relay have no merge-confirmation button yet. The confirmation path is in
  `approvals.ts`, so adding one is a client change, not a new path.
- Cancel needs a verified mission, as the rule was given. That makes cancel rare in practice
  (a running mission has nothing verified). Whether an agent may cancel its own **unverified**
  mission is the user's call.
