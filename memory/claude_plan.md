# Current invocation plan

I will follow `TODO.md` as the authoritative task list and complete exactly the first task whose heading is not prefixed with `[DONE]`. I will not perform unrelated issue triage before identifying that task.

Execution steps:
1. Read `TODO.md` to find the first incomplete task and its validation requirements.
2. Check recent repository state only as needed for that task, including the latest commit if it appears directly relevant.
3. Inspect the implementation and tests connected to the selected task.
4. Implement the task completely, adding or updating tests and documentation where the task requires it.
5. Run formatting, linting, and relevant tests in the required order; if a failing test is not already scheduled, fix it or add the minimum prerequisite task before marking the current task complete.
6. Update this plan file at major milestones.
7. Mark the completed task in `TODO.md` by prefixing its heading with `[DONE]` and updating its completion record.
8. Commit all changes for this invocation with a descriptive message and the required co-author trailer.
9. Stop without starting the next task.

Milestone update:
- Identified `T01 [TODO] 初始化 TypeScript 项目骨架` as the first incomplete task. I will implement only this task in this invocation.
- Created the initial TypeScript project files, startup entry points, `.gitignore`, and tracked source directories required by T01. Next I will install dependencies and run the required validation scripts.
- Installed dependencies, validated `typecheck`, `build`, `dev`, and `start`, and marked T01 complete in `TODO.md`. Next I will review the git diff and commit this invocation's changes.
