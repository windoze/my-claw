# Current invocation plan

I will work from `TODO.md` as the source of truth, complete exactly the first task whose heading is not prefixed with `[DONE]`, update the task record, commit the result, and stop.

## Selected task

`T08 [DONE] 实现 slash command 解析器`

## Implementation approach

Add the command parser and command type definitions in `src/commands/parseCommand.ts` and `src/commands/types.ts`. The parser will only classify non-empty text beginning with `/`, normalize command names to lowercase, preserve the original argument string as `argsText`, recognize the first-stage commands `/cc`, `/close`, `/state`, `/stop`, and `/oc`, and return an `unknown` command classification for unsupported slash commands. It will also provide basic argument tokenization that supports quoted paths containing spaces and explicit parse errors for malformed quotes instead of silently accepting ambiguous input.

## Execution steps

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

## Progress

Identified T08 as the first incomplete task. The latest commit completed T07 and did not mention unfinished work relevant to T08. Fixed the `src/utils/logger.ts` syntax error that blocked validation, added slash command parser/type contracts, verified `npm run typecheck`, `npm run build`, and parser acceptance cases, and marked T08 `[DONE]` in `TODO.md`. Next I will commit and stop.
