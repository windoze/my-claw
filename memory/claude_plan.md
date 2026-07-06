## Current invocation plan

I will work from `TODO.md` as the source of truth, complete exactly the first task whose heading is not prefixed with `[DONE]`, update the task record, commit the result, and stop.

### Selected task

`T06 [TODO] 增加日志工具和错误类型`

### Implementation approach

Add `src/utils/logger.ts` and `src/utils/errors.ts`, export them from `src/utils/index.ts`, route startup and app logs through scoped loggers, and replace the existing StateStore fallback console warning with the shared logger surface. Existing config, path, policy, and state errors will be made compatible with the new `AppError` base where practical so callers can classify failures consistently.

### Progress

Implemented and validated T06. `TODO.md` has been updated with `[DONE]` and a completion record. Next step is committing the task changes only, then stopping.

### Execution steps

1. Read `TODO.md` to identify the first incomplete task and its requirements, dependencies, and validation instructions.
2. Check the latest commit message only for directly relevant unfinished work tied to that selected task.
3. Inspect only the files needed to understand and implement that task.
4. Implement the task without narrowing scope or using workarounds.
5. Run formatting, linting, and relevant tests in the required order, escalating to the full suite when required by the task or by code changes.
6. Fix any observed failing test unless it is already explicitly scheduled in `TODO.md`; otherwise add the minimum prerequisite/follow-up task before marking the current task done.
7. Update `TODO.md` by prefixing the completed task heading with `[DONE]` and filling in its completion record.
8. Update this plan file at key milestones.
9. Commit all task-related changes with a descriptive message and the required co-author trailer.
10. Stop without starting the next task.
