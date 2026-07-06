# Execution Plan

I will complete exactly the first incomplete task in `TODO.md` and stop after committing it. This file records a concise execution plan and progress notes; it does not include private chain-of-thought.

Selected task: `T20 [DONE] 实现 SecurityGate 私聊和单用户校验`.

Step-by-step plan:
1. Read `TODO.md` to identify the first task whose heading is not prefixed with `[DONE]`.
2. Check the latest commit message only for directly relevant unfinished work tied to the selected task.
3. Inspect the selected task's referenced files, requirements, dependencies, and validation instructions.
4. Implement the task completely, adding or updating tests and documentation only where directly required.
5. Run formatting, linting, and relevant tests in the required order, fixing or explicitly scheduling any unscheduled failures.
6. Update `TODO.md` by prefixing the completed task heading with `[DONE]` and filling in its completion record.
7. Commit all changes for this task with a descriptive message and the required co-author trailer.
8. Stop without starting the next task.

Progress:
- Plan refreshed for the current invocation before implementation commands.
- Identified `T20 [TODO] 实现 SecurityGate 私聊和单用户校验` as the first incomplete task.
- Latest commit completed T19 and does not identify an unfinished issue blocking T20.
- Baseline `npm run typecheck` and `npm run build` pass before T20 edits.
- Implemented `SecurityGate`, wired it before command/backend routing, and extended fake-message runtime to exercise authorization outcomes.
- Verified authorized private `/state`, unauthorized private messages, group messages, empty text handling, existing fake-message path, `npm run typecheck`, and `npm run build`.
- Marked T20 as `[DONE]` in `TODO.md` with the completion record.
