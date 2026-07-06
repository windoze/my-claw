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

- Current invocation selected first incomplete task: `T13 [TODO] 定义 BackendAdapter 与 BackendRegistry`.
- Latest commit already completed T12, and the worktree started clean.
- T13 implementation plan:
  1. Inspect current backend type definitions, fake backend implementation, session environment types, command/router exports, and package scripts.
  2. Extend `src/backend/types.ts` with the stable `BackendAdapter` and `BackendSession` contracts while preserving the existing `AgentEvent` stream shape.
  3. Add `src/backend/BackendRegistry.ts` with adapter registration and lookup by `AgentEnvironment.backend`, returning a user-facing error for unsupported backends.
  4. Update backend exports and existing fake/testing code to conform to the new adapter interface.
  5. Add focused local validation for registering/getting the `claude-code` backend and safe unknown-backend errors, using fake components rather than real Claude Code.
  6. Run formatting, typecheck/build, and the focused validation.
  7. Mark T13 `[DONE]` with completion notes, commit all T13-related changes, and stop.
- Implemented backend contracts in `src/backend/types.ts`, added `BackendRegistry` and `src/backend/index.ts`, and adapted the fake backend/message runner to use `open -> send event stream -> close` through the registry.
- Validation passed: `npm run typecheck`, `npm run build`, `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`, and a focused `tsx` registry check for `claude-code` resolution plus `opencode` unsupported-backend safe error handling.
- Marked `T13` as `[DONE]` in `TODO.md` with the completion record.
- Next step: review final diff, commit T13 changes, and stop.
