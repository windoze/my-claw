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
- Current invocation started. I re-read `TODO.md` and selected first incomplete task `T30 [TODO] 第二阶段实现钉钉卡片或 AI Card 流式输出`.
- Plan for T30: check the latest commit for directly relevant unfinished work, inspect existing output rendering, app routing, DingTalk reply/media helpers, config schema/types, README/config sample, and package scripts; then implement card streaming configuration, a DingTalk card client abstraction, a throttled card renderer with Markdown fallback, app wiring, fake/local validation coverage, TODO completion update, and a commit.
- Latest commit is `[T29] Implement user attachment input`, which completed adjacent attachment work and does not mention unfinished T30 card streaming work.
- Implementation milestone: added `streaming` configuration defaults and validation, optional reply-sink card streaming contracts, DingTalk AI Card client/streamer, throttled `CardStreamingRenderer`, output/app stream wiring, fake reply sink card recording, sample config, and README documentation. `npm run typecheck`, `npm run build`, focused card streaming checks, and the fake message integration path passed.
- Completion milestone: marked `T30` `[DONE]` in `TODO.md` with the implementation and validation record. Final validation `npm run typecheck && npm run build && npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"` passed. Next step is committing all T30 changes.
