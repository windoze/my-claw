## Current invocation plan

### Reasoning summary

The authoritative source for this invocation is `TODO.md`. The first incomplete task is `T16 [TODO] 打通普通消息到 Claude Code 的本地路由`. I will complete only T16, validate it with the repository's existing tooling and the task's stated requirements, update the task's completion record, commit the resulting changes, and stop. The latest commit is `[T15] Implement Claude Code session resume`, which is directly upstream of T16 because T16 must preserve and persist session IDs while routing ordinary messages.

### Step-by-step execution plan

1. Inspect the existing app startup, command router, session manager, backend registry/adapters, fake testing route, and output utilities.
2. Add an `OutputRenderer` that consumes `AgentEvent` streams and sends rendered replies through `ReplySink`.
3. Implement `handleIncomingMessage(message, replySink)` so slash commands short-circuit, ordinary messages obey `SessionManager.canAcceptNormalMessage()`, runtime state transitions to `running`, backend events are rendered, session IDs are persisted, backend sessions are closed, and `finally` restores `idle` after success or failure.
4. Wire the local fake-message route and app composition through the same ordinary-message handler so local validation covers the real route shape.
5. Run `npm run typecheck`, `npm run build`, and focused fake-message checks for ordinary-message success, busy rejection, and failure recovery.
6. Update `TODO.md` by marking T16 `[DONE]` and adding the completion record.
7. Commit all T16-related changes with a descriptive message and required co-author trailer, then stop.

### Progress

- Selected first incomplete task: `T16 [TODO] 打通普通消息到 Claude Code 的本地路由`.
- Latest commit checked: `[T15] Implement Claude Code session resume`; no unfinished issue from that commit preempts T16.
- Initial inspection completed for app startup, command routing, session state, backend interfaces, and output contracts.
- Implemented a shared incoming-message handler in `src/app.ts` that short-circuits slash commands, routes normal messages through the selected backend, persists completion session IDs, renders collected Agent events, closes backend sessions, and restores runtime state to `idle`.
- Added `OutputRenderer` with first-stage Markdown rendering for text, done, error, stopped, and empty-output events.
- Updated the fake-message runtime to exercise the shared handler instead of maintaining a separate normal-message route.
- Validation completed: `npm run typecheck`, `npm run build`, the fake-message smoke route, and focused local checks for backend routing, `idle -> running -> idle`, busy rejection text, and failure recovery.
- Marked `T16` as `[DONE]` in `TODO.md` with a completion record.
