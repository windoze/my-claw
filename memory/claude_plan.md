# Execution Plan

I will follow `TODO.md` as the authoritative task list, complete only the first task whose heading is not prefixed with `[DONE]`, update the task record, validate the relevant behavior, and commit the resulting changes before stopping.

Planned steps:
1. Read `TODO.md` to identify the first incomplete task and its validation requirements.
2. Check the latest commit only for unfinished work directly relevant to that task.
3. Inspect the files needed for that task and avoid unrelated issue triage.
4. Implement the task as specified, adding only necessary prerequisite tasks if a concrete blocker makes direct completion impossible.
5. Run formatting, linting, and tests required by the task and repository policy.
6. Update `TODO.md` with a `[DONE]` prefix and completion record if the task is completed, or record any required prerequisite/blocker task if it is not.
7. Update this progress file at key milestones.
8. Commit all task-related changes with a clear task-specific message and then stop.

Progress update:
- First incomplete task identified: `T26 [TODO] 第二阶段接入 OpenCode SDK 和 OpenCodeAdapter`.
- Latest commit is phase 1 acceptance and does not indicate unfinished work that changes the T26 scope.
- Next I will inspect the existing backend abstractions and Claude adapter patterns, install and inspect `@opencode-ai/sdk`, then add OpenCode support under the existing `BackendAdapter` contract.
- SDK inspection complete: `createOpencode()` starts a local server and exposes a generated client; session prompt streaming uses `event.subscribe()` plus `session.promptAsync()`, with `message.part.updated`, `session.idle`, and `session.error` as the relevant event mappings.
- OpenCode CLI is present at `/opt/homebrew/bin/opencode`, so I will run a real smoke validation after focused fake checks.
- Implementation milestone: added `OpenCodeAdapter`, centralized `mapOpenCodeEvent`, OpenCode backend exports, app registry wiring, SDK dependency, and an `npm run opencode:prompt` local smoke script. Next I will type-check and fix any SDK integration mismatches.
- Validation milestone: fixed the OpenCode SDK `messageID` mismatch by not forwarding DingTalk message IDs, filtered event mapping to assistant text parts only, changed the adapter to reuse one lazy OpenCode server with per-cwd contexts, and verified typecheck, build, fake routing, focused adapter checks, and real `opencode:prompt` smoke.
- Task record milestone: marked `T26` as `[DONE]` in `TODO.md` with a completion record. Next I will inspect the final diff and create the required task commit.
