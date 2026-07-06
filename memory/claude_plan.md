# Current invocation plan

I will work from `TODO.md` as the source of truth, complete exactly the first task whose heading is not prefixed with `[DONE]`, update the task record, commit the result, and stop.

## Selected task

`T07 [DONE] 定义统一消息、回复和 Agent 环境类型`

## Implementation approach

Define the shared internal contracts in `src/messages/types.ts`, `src/output/types.ts`, `src/session/types.ts`, and `src/backend/types.ts` without importing concrete implementation classes. Reuse existing configuration types where appropriate, keep backend support constrained to first-stage `"claude-code"`, and ensure event/input/reply structures match the TODO requirements.

## Execution steps

1. Read `TODO.md` to identify the first incomplete task and its requirements, dependencies, and validation instructions.
2. Check the latest commit message only for directly relevant unfinished work tied to that selected task.
3. Inspect only the files needed to understand and implement that task.
4. Implement the task without narrowing scope or using workarounds.
5. Run formatting, linting, and relevant tests in the required order, escalating to the full suite when required by the task or by code changes.
6. Fix any observed failing test unless it is already explicitly scheduled in `TODO.md`; otherwise add the minimum prerequisite/follow-up task before marking the current task done.
7. Update `TODO.md` by prefixing the completed task heading with `[DONE]` and filling in its completion record.
8. Update this plan file at key milestones.
9. Commit all task-related changes with a descriptive message and the required co-author trailer.
10. Stop without starting the next task.

## Progress

Identified T07 as the first incomplete task. The latest commit only completed T06 and did not mention relevant unfinished work. Added implementation-free shared contracts for incoming messages, reply sinks, Agent environments, Agent input, and Agent events. `npm run typecheck` and `npm run build` passed. `TODO.md` now marks T07 `[DONE]` with a completion record. Next I will commit these changes and stop.
