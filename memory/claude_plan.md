## Current invocation plan

### Reasoning summary

I cannot include private chain-of-thought, but I will maintain this file with the actionable reasoning summary, execution plan, and progress. `TODO.md` is the authoritative task list; this invocation will complete the first task whose heading is not prefixed with `[DONE]`, then stop after committing the result.

### Step-by-step execution plan

1. Read `TODO.md` to identify the first incomplete task and its validation requirements.
2. Check the latest commit for any explicitly unfinished issue that directly affects that selected task.
3. Inspect the message route, command router, session manager, backend adapter, renderer, and fake testing surfaces that control `/stop`.
4. Implement T17 completely by registering the active backend session/stop callback, making `/stop` transition through `stopping`, invoking backend cancellation, draining the current stream, rendering a stopped result, and restoring `idle`.
5. Add focused local checks for running stop, repeated stop, state recovery, and continued normal-message acceptance after interruption.
6. Run required formatting, linting/build/type checks, and relevant tests/scripts.
7. Update `TODO.md` by prefixing T17 with `[DONE]` and adding/updating its completion record.
8. Update this file at major milestones.
9. Commit all task-related changes with a clear T17 message and required co-author trailer.
10. Stop without starting the next task.

### Progress

- Selected first incomplete task: `T17 [TODO] 实现 /stop 对 Claude Code 的真实中断`.
- Latest commit checked: `dd67451 [T16] Route ordinary messages through backend`; it is directly upstream of T17 and does not add a separate unfinished issue that preempts T17.
- Completed implementation inspection for app routing, SessionManager state transitions, command handlers, ClaudeCodeAdapter cancellation, and fake backend support.
- Implemented active task control in `SessionManager`, registered/cleared it from the normal-message route, and made `/stop` request the stored backend stop function.
- Updated `ClaudeCodeAdapter.stop()` to call SDK `Query.interrupt()`, drain to `AgentEvent.stopped`, preserve interrupted session IDs when available, and force abort/close only on interrupt failure.
- Extended fake backend stop controls for local long-task, repeated-stop, and failure-recovery checks.
- Validation completed: `npm run typecheck`, `npm run build`, `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`, focused stop-flow check, focused Claude adapter interrupt check, and focused stop-failure recovery check.
- Marked `T17` as `[DONE]` in `TODO.md` with a completion record.
