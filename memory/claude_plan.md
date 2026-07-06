# Execution Plan

I will not include private chain-of-thought here, but this file records the actionable plan, assumptions, and progress for this invocation.

## Initial Plan

1. Read `TODO.md` to identify the first task whose heading is not prefixed with `[DONE]`.
2. Review only the files and recent commit context needed for that task.
3. Implement the selected task completely, or add the minimum prerequisite task to `TODO.md` if a concrete blocker makes correct implementation impossible.
4. Run the required validation in order: formatting, linting, then relevant/full tests as required by the task and repository conventions.
5. Update `TODO.md` with `[DONE]` and a completion record for the completed task, or record a blocker/prerequisite if completion is impossible.
6. Update this file at key milestones.
7. Commit all changes for this invocation with a clear task-specific message and the required co-author trailer.

## Progress

- Created this execution plan before inspecting the task list or running project commands.
- Identified `T22 [TODO] 组装真实 App 启动流程` as the first incomplete task. Latest commit is `[T21] Implement DingTalk reply sink`, which is directly prior work and does not add a separate unfinished prerequisite.
- Implemented the T22 wiring path in `src/app.ts` and `src/index.ts`: the runtime now creates the real DingTalk adapter, injects the shared safe incoming-message handler, starts the Stream client, and installs shutdown cleanup for Stream and active backend work.
- Validated TypeScript build output and exercised `startApp()` with a temporary config plus fake DingTalk Stream client, confirming callback registration, connection, and runtime close/disconnect behavior.
- Marked T22 `[DONE]` in `TODO.md`. Final validation passed with `npm run typecheck`, `npm run build`, and `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`.
