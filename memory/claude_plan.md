# Current invocation plan

I will follow `TODO.md` as the source of truth and complete only the first task whose heading is not prefixed with `[DONE]`.

Step-by-step plan:

1. Read `TODO.md` to identify the first incomplete task, without doing broad issue triage first.
2. Check the latest commit only for unfinished work directly relevant to that selected task.
3. Inspect the files and tests needed for the selected task.
4. Implement the task completely, or add the minimum prerequisite task in `TODO.md` if a concrete blocker makes implementation impossible.
5. Run formatting, linting, and relevant tests in the required order, escalating to the full suite when code changes require it.
6. Update this file at key milestones and update `TODO.md` by prefixing the completed task title with `[DONE]` and filling in its completion record.
7. Commit all task-related changes with a clear message and stop without starting the next task.

## Selected task

First incomplete task: `T09 [TODO] 实现 CommandRouter 框架`.

T09 requires a `CommandRouter.handle(message, replySink)` entry point that:

1. Calls `parseCommand`.
2. Returns `false` for non-command messages so upstream code can send them to the Agent.
3. Returns `true` for handled commands.
4. Routes `/state`, `/oc`, unknown commands, and placeholder handlers for `/cc`, `/close`, and `/stop`.
5. Replies with `UserFacingError.safeMessage` for user-facing handler errors.
6. Replies with a generic error and logs details for unexpected handler errors.

## Progress

Identified T09 as the first incomplete task. The latest commit completed T08 and did not mention unfinished work that changes the scope of T09. Added `CommandRouter`, default command handlers, and public command exports. `npm run typecheck` initially found a TypeScript narrowing issue in dispatch; I fixed it and reran `npm run typecheck` successfully. `npm run build` and fake message/fake reply behavior checks passed for non-command routing, known command dispatch, unknown command handling, invalid command handling, `UserFacingError.safeMessage`, and generic error logging. Marked T09 `[DONE]` in `TODO.md`. Next I will commit the task changes and stop.
