# Execution plan

I will keep this file as a concise progress log and execution plan. I cannot record private chain-of-thought, but I will document the concrete steps, decisions, blockers, and validation status needed to make the work auditable.

1. Read `TODO.md` to identify the first task whose heading is not prefixed with `[DONE]`.
2. Inspect only the files and context needed for that task, plus the latest commit if it explicitly affects the selected task.
3. Implement the selected task completely, or add the minimum prerequisite task in `TODO.md` if a concrete blocker prevents correct implementation.
4. Run formatting, linting, and relevant/full tests according to the task requirements and project policy.
5. Update `TODO.md` with `[DONE]` and a completion record if the task is complete; update `PLAN.md` only if phase-level sequencing changes.
6. Commit all resulting changes with a descriptive message and stop without starting the next task.

Status: selected first incomplete task `T23 [TODO] 增加消息去重和 Stream 重连处理`.

Task-specific plan:

1. Inspect `src/dingtalk/DingTalkAdapter.ts`, existing DingTalk types, app startup wiring, and package scripts.
2. Add a `MessageDeduper` that tracks processed message keys for a 5-minute TTL, prunes old entries, ignores duplicates, and creates a warn-logged weak key when `message.id` is missing.
3. Wire deduplication into the DingTalk callback path before security, command routing, and backend execution.
4. Add connection-state/error/reconnect logging around the DingTalk Stream client using available SDK hooks or documented fallback behavior without bypassing the SDK lifecycle.
5. Validate with formatting/typecheck/build and focused local checks for duplicate handling, weak-key handling, and connection logging.
6. Mark T23 `[DONE]` with a completion record, then commit all changes.

Progress:

- Added the `MessageDeduper` design and wired it into the DingTalk callback path before handler execution.
- Updated internal message/input contracts so a missing DingTalk message ID can be represented and handled with a weak dedupe key.
- Added Stream SDK lifecycle/connection logging around public event hooks, SDK debug status messages, system frames, and startup connection failures.
- Moved Stream lifecycle logging helpers into `src/dingtalk/StreamLifecycleLogger.ts` to keep `DingTalkAdapter` focused.
- Validation completed with `npm run typecheck`, `npm run build`, focused T23 behavior checks including a post-close/reconnect callback path, `git diff --check`, and `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`.
- `TODO.md` now marks T23 `[DONE]` with a completion record.
- Next step: inspect git diff and commit the T23 changes.
