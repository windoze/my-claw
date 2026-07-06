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
- First incomplete task identified: `T27 [TODO] 第二阶段实现 /oc <dir> 项目切换`.
- Latest commit completed T26 and does not indicate unfinished work that changes the T27 scope.
- Implementation milestone: configuration and state validation now allow `opencode`; `SessionManager` can open Claude Code or OpenCode projects with per-backend known-project keys; `/oc <dir>` is wired through command handlers; `/state` renders `Claude Code` and `OpenCode` labels; fake routing registers the fake backend for both backend names; README no longer describes `/oc` as a placeholder.
- Validation milestone: `npm run typecheck`, focused T27 fake checks, OpenCode config schema check, `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/oc ." "hello opencode" "/close"`, and `npm run build` all passed.
- Task record milestone: marked `T27` as `[DONE]` in `TODO.md` with a completion record. Next I will inspect the final status and commit all task-related changes.
