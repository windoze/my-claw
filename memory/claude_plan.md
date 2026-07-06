# Current invocation plan

I will follow `TODO.md` as the authoritative task list and complete exactly the first task whose heading is not prefixed with `[DONE]`. I will not perform unrelated issue triage before identifying that task.

Execution steps:
1. Read `TODO.md` to find the first incomplete task and its validation requirements.
2. Check the latest commit message only for unfinished work directly relevant to that selected task.
3. Inspect the files, implementation boundaries, and tests connected to the selected task.
4. Implement the task completely, adding or updating tests and documentation where required.
5. Run required formatting, linting, and tests in the requested order; if a failing test is not already scheduled, fix it or add the minimum prerequisite task before marking the current task complete.
6. Update this plan file at major milestones.
7. Mark the completed task in `TODO.md` by prefixing its heading with `[DONE]` and updating its completion record.
8. Commit all changes for this invocation with a descriptive message and the required co-author trailer.
9. Stop without starting the next task.

Milestone update:
- Refreshed this plan for the current invocation. Next I will identify the first incomplete `TODO.md` task and scope all work to it.
- Identified `T02 [TODO] 增加配置样例和配置类型` as the first incomplete task. I will implement only this task in this invocation.
- Added `agent-dingtalk.config.example.jsonc` and standalone config interfaces in `src/config/types.ts`. Next I will validate the JSONC sample and TypeScript build.
- Validated the JSONC example, TypeScript typecheck, and build; marked T02 complete in `TODO.md`. Next I will review and commit the task changes.
