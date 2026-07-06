# Execution Plan

I will follow `TODO.md` as the authoritative task list, complete only the first task whose heading is not prefixed with `[DONE]`, update the task record, validate the relevant behavior, and commit the resulting changes before stopping.

Planned steps:
1. Read `TODO.md` to identify the first incomplete task and its validation requirements.
2. Check the latest commit only for unfinished work directly relevant to that task.
3. Inspect the files needed for the selected task and avoid unrelated issue triage.
4. Implement the task as specified, adding only necessary prerequisite tasks if a concrete blocker makes direct completion impossible.
5. Run formatting, linting or type checking, and relevant tests required by the task and repository policy.
6. Update `TODO.md` with a `[DONE]` prefix and completion record if the task is completed, or record any required prerequisite/blocker task if it is not.
7. Update this progress file at key milestones.
8. Commit all task-related changes with a clear task-specific message and then stop.

Progress update:
- Current invocation started. I re-read `TODO.md` and selected first incomplete task `T29 [TODO] 第二阶段实现用户附件输入`.
- Latest commit is `[T28] Implement local file download command`, which is directly adjacent but does not mention unfinished T29 work.
- Plan for T29: inspect DingTalk message mapping/media helpers, message/backend input types, fake runtime, Claude/OpenCode adapters, app routing, config/security, `.gitignore`, README, and TODO completion format; then add attachment metadata, controlled temporary download storage and cleanup, DingTalk media download, prompt augmentation for backends, focused validation, TODO completion update, and a commit.
- Implementation milestone: added normalized attachment metadata, attachment security config defaults, `.agent-dingtalk-tmp/` ignore, `TempFileStore` with size/type validation and cleanup, DingTalk `messageFiles.download` media client/resolver, post-authorization attachment materialization, and shared backend prompt augmentation for Claude Code/OpenCode. `npm run typecheck` passed.
- Validation and completion milestone: focused attachment checks passed for file/image mapping, DingTalk token + download request, local temp save, prompt localPath propagation, unsupported MIME rejection, oversized attachment rejection, fake backend attachment input, and TTL cleanup. Final `npm run typecheck && npm run build && npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"` passed. `T29` is marked `[DONE]` in `TODO.md`; next step is committing all T29 changes.
