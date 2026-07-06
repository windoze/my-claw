# Execution Plan

I will complete exactly the first incomplete task in `TODO.md` and stop after committing it.

Selected task: `T19 [TODO] 安装并封装钉钉 Stream SDK`.

Scope for this invocation:
- Install the official `dingtalk-stream-sdk-nodejs` package.
- Add DingTalk Stream adapter types, message mapping, and adapter startup/callback registration.
- Keep business routing outside the adapter by injecting a handler.
- Log redacted raw callback samples at debug level and warn on missing/unmappable fields.
- Validate with typecheck/build and focused mapping/adapter checks, then mark T19 done and commit.

Progress:
- Identified `T19 [TODO] 安装并封装钉钉 Stream SDK` as the first incomplete task.
- Confirmed the official package/API as `dingtalk-stream-sdk-nodejs`.
- Installed the SDK and verified the existing `npm run typecheck` and `npm run build` baseline pass.
- Added DingTalk Stream adapter types, centralized raw callback mapping, adapter startup/callback registration, redacted debug samples, and warn-on-mapping-failure behavior.
- Added idempotent Stream callback registration so retrying or restarting the adapter does not duplicate message handlers.
- Verified `npm run typecheck`, `npm run build`, focused DingTalk mapper/adapter checks, and the existing fake-message integration path.
- Marked `T19` as `[DONE]` in `TODO.md` with the completion record.

1. Read `TODO.md` to identify the first task whose heading is not prefixed with `[DONE]`.
2. Check the latest commit message only for directly relevant unfinished work tied to that selected task.
3. Inspect the selected task's referenced files, requirements, dependencies, and validation instructions.
4. Implement the task completely, adding or updating tests and documentation only where directly required.
5. Run formatting, linting, and the relevant/full test commands required by the task, fixing any unscheduled failures that appear.
6. Update `TODO.md` by prefixing the completed task heading with `[DONE]` and filling in its completion record.
7. Commit all changes for this task with a descriptive message and the required co-author trailer.
8. Stop without starting the next task.
