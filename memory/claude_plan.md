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
- Current invocation started. I re-read `TODO.md` and selected first incomplete task `T28 [TODO] 第二阶段实现 /dl <path> 本地文件发送`.
- Latest commit is `[T27] Implement OpenCode project switching`, which does not mention unfinished work directly changing T28 scope.
- Next steps for T28: inspect config, path policy, command handlers, reply sink, and existing fake/testing surfaces; add the download file service and configuration; wire `/dl`; validate allowed paths, file type, size, symlink escape, DingTalk send failure handling, audit logging, and documentation/task record.
- Implementation milestone: added `security.downloadAllowedDirs`/`maxDownloadFileBytes`, allowed-file realpath policy checks, `FileService`, `/dl` parser/handler wiring, fake reply file recording, and DingTalk media upload + token-cache backed file replies. Typecheck found several wiring issues; I am correcting those before focused validation.
- Validation milestone: `npm run typecheck` passed. Focused fake-message checks showed `/dl README.md` and an allowlisted temp file sending as file replies, while an outside file, symlink escape, and oversized file were rejected with basename-only user messages.
- Completion milestone: directory rejection and simulated DingTalk/file send failure prompts were validated; final `npm run typecheck && npm run build` passed; `T28` is now marked `[DONE]` in `TODO.md` with its completion record. Next step is to commit all T28 changes.
