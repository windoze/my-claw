# Execution Plan

## Current objective

Complete exactly the first incomplete task in `TODO.md`, then stop after documenting and committing the result.

## Plan

1. Read `TODO.md` to identify the first heading that is not explicitly prefixed with `[DONE]`.
2. Check the latest commit message only for unfinished work directly relevant to that selected task.
3. Inspect the selected task's requirements, dependencies, validation instructions, and nearby completion records.
4. Read only the relevant project files needed to implement the selected task correctly.
5. Implement the task without narrowing scope or introducing workarounds.
6. Run formatting, linting, and relevant tests in the required order; run the full suite when code changes require it.
7. Fix any observed unscheduled failing tests or add the minimum prerequisite task in `TODO.md` if a blocker prevents completion.
8. Mark the completed task title with `[DONE]` in `TODO.md` and update its completion record.
9. Update this plan file at major milestones and update `PLAN.md` only if phase-level sequencing changes.
10. Commit all task-related changes with a descriptive message and the required co-author trailer.

## Progress

- Initial execution plan written before project inspection.
- Selected first incomplete task: `T03 [TODO] 实现配置加载和 Zod 校验`.
- Latest commit is `[T02] Add config example and types`; it does not mention unfinished work relevant to T03.
- Implemented JSONC config schema, loader, public exports, and startup integration.
- Validation completed: typecheck, build, missing config guidance, invalid field-path error, example config loading, and defaulted field loading.
