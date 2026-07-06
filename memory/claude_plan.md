## Current invocation plan

### Reasoning summary

The authoritative source for this invocation is `TODO.md`. I will identify the first task whose heading is not explicitly prefixed with `[DONE]`, complete only that task, validate it according to the repository's existing tooling and the task's stated requirements, update the task's completion record, commit the resulting changes, and stop. I will not perform broad issue triage before selecting the current task. If a blocker directly prevents the selected task, I will add the minimum prerequisite task to `TODO.md`, commit that bookkeeping, and stop.

### Step-by-step execution plan

1. Read `TODO.md` to find the first incomplete task and its validation/completion requirements.
2. Check the latest commit message only for unfinished work directly relevant to that selected task.
3. Inspect the repository structure and files needed for the selected task.
4. Implement the task completely, avoiding unrelated changes and preserving existing conventions.
5. Run formatting, linting, and tests required by the task and repository, in that order where applicable.
6. If validation exposes unscheduled failures, fix them if in scope or add the minimum prerequisite/follow-up task before marking the task done.
7. Update this progress file at key milestones.
8. Mark the completed task title in `TODO.md` with `[DONE]` and update its completion record.
9. Commit all changes relevant to this invocation with a descriptive message and the required co-author trailer.
10. Stop after completing exactly one task.

### Progress

- Selected first incomplete task: `T15 [TODO] 实现 Claude Code session 保存和恢复`.
- Relevant existing support found: `SessionManager` already persists session IDs for default/project environments and exposes them on `AgentEnvironment`; fake routing already saves `done.sessionId`.
- Main implementation gap: `ClaudeCodeAdapter` opens sessions with stored IDs but does not pass `resume` to the SDK or fall back to a new session when resume fails.
- Implemented adapter support for SDK `options.resume`, session ID refresh from successful result messages, warning + user-visible text when resume fails, and retry as a new session while preserving `/stop` abort handling.
- Added `npm run claude:prompt -- --resume <session-id>` support for local resume validation.
- Validation completed: TypeScript typecheck, build, fake message route, mocked SDK resume/fallback/session refresh checks, real Claude Code `--resume` context recovery, and persisted fake-state restoration.
- Marked `T15` as `[DONE]` in `TODO.md` with a completion record.
