# Execution Plan

I will maintain this file as a concise progress log and actionable plan. I will not record hidden chain-of-thought, but I will record the decisions, task status, and step-by-step execution plan needed to audit progress.

## Current Plan

1. Read `TODO.md` to identify the first task whose title is not prefixed with `[DONE]`.
2. Review the selected task's requirements, dependencies, validation notes, and any directly relevant latest-commit context.
3. Inspect only the code and documentation needed for that task.
4. Implement the task completely, or add the minimum prerequisite task to `TODO.md` if a concrete blocker prevents correct implementation.
5. Run formatting, linting, and relevant tests in the required order.
6. Update `TODO.md` with a `[DONE]` prefix and completion record if the task is completed; update `PLAN.md` only if phase-level planning changes.
7. Commit all task-related changes with a clear message and the required co-author trailer.
8. Stop after exactly one task.

## Progress

- Existing progress log showed T11 as completed in the previous commit.
- Selected first incomplete task: `T12 [TODO] 增加 FakeReplySink 和 FakeBackend 便于本地集成测试`.
- T12 implementation plan:
  1. Inspect command routing, backend event types, session manager construction, config/state helpers, and package scripts.
  2. Add `FakeReplySink` that records `sendText` and `sendMarkdown` calls.
  3. Add `FakeBackendAdapter` whose `send` method returns deterministic `text` and `done` events.
  4. Add a local fake-message runner or equivalent script that builds an `IncomingMessage`, runs `CommandRouter`, and routes non-command messages to the fake backend.
  5. Add or update scripts so the fake path can be exercised without DingTalk or Claude Code.
  6. Run formatting, typecheck/build, and focused fake-route validation.
  7. Mark T12 `[DONE]` with completion notes, commit the task changes, and stop.
- Inspected `CommandRouter`, command handlers, backend/message/reply/session types, `SessionManager`, `StateStore`, and `PathPolicy`.
- Design decision: implement fake testing as reusable exported classes plus a `runFakeMessage` helper/CLI using the real `CommandRouter` and `SessionManager`, with ephemeral temp state by default so it requires neither DingTalk nor Claude Code.
- Implemented `FakeReplySink`, `FakeBackendAdapter`, `runFakeMessage` helper/CLI, testing exports, and the `npm run fake:message` script.
- Validation passed: `npm run typecheck`, `npm run build`, and `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`.
- Marked `T12` as `[DONE]` in `TODO.md` with the completion record.
- Next step: review final diff, commit T12 changes, and stop.
