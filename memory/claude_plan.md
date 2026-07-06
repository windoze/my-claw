# Execution Plan

I will follow `TODO.md` as the source of truth, identify the first task whose heading is not prefixed with `[DONE]`, complete exactly that task, validate it according to the task and repository requirements, update `TODO.md` with the completion record and `[DONE]` prefix, then commit the resulting changes.

Steps:
1. Read `TODO.md` first and select the first incomplete task.
2. Check the latest commit only for unfinished work directly relevant to that selected task.
3. Inspect the files and tests needed for the selected task.
4. Implement the task without narrowing scope or using workarounds.
5. Run formatting, linting, and relevant tests in the required order.
6. If validation reveals unscheduled failures, fix them if in scope or add the minimum prerequisite task to `TODO.md` before stopping.
7. Update `TODO.md` so the completed task title is prefixed with `[DONE]` and its completion record reflects the work and validation.
8. Update this plan file at key milestones.
9. Commit all task-related changes with a descriptive message and stop.

Progress:
- Selected first incomplete task: `T14 [TODO] 接入 Claude Code Agent SDK 基础调用`.
- Latest commit completed T13 and does not add an unfinished blocker for T14.
- Baseline `npm run typecheck` and `npm run build` passed before code changes.
- Installed `@anthropic-ai/claude-agent-sdk` and reviewed its `query()` API, `Options`, `PermissionMode`, `SDKMessage`, and `SDKResultMessage` types.
- Implementation will add `ClaudeCodeAdapter`, Claude backend types, backend exports, and a local prompt script that exercises the adapter without DingTalk.
- Implemented and exported `ClaudeCodeAdapter`, added the `claude:prompt` local script, tightened Claude permission-mode config validation, and marked T14 `[DONE]` in `TODO.md`.
- Validation completed: TypeScript typecheck, build, fake message routing, real Claude prompt response, and real `cwd` verification through a `pwd` tool call in a temporary directory.
- Final step: inspect the git diff, ensure only T14-related changes are present, then commit the completed task.
