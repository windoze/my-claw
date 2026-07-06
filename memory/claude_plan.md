# Execution Plan

I will complete exactly the first incomplete task in `TODO.md` and stop after committing it. This file records a concise execution plan and progress notes; it does not include private chain-of-thought.

Selected task: `T21 [DONE] 实现钉钉 Text 和 Markdown 回复`.

Step-by-step plan:
1. Read `TODO.md` to identify the first task whose heading is not prefixed with `[DONE]`.
2. Check the latest commit message only for directly relevant unfinished work tied to the selected task.
3. Inspect DingTalk adapter, message/reply context, output sink types, logging, and package scripts.
4. Implement `DingTalkReplySink` for text and Markdown replies using the SDK reply API or `sessionWebhook`, with safe failure logging and no token leakage.
5. Wire the sink into `DingTalkAdapter` so authorized private messages can receive `/state` and Agent replies.
6. Run formatting, linting/typecheck, build, and focused local checks in the required order, fixing or scheduling any unscheduled failures.
7. Update `TODO.md` by prefixing T21 with `[DONE]` and filling in its completion record.
8. Commit all changes for T21 with a descriptive message and the required co-author trailer, then stop.

Progress:
- Plan refreshed for the current invocation.
- Identified `T21 [TODO] 实现钉钉 Text 和 Markdown 回复` as the first incomplete task.
- Latest commit completed T20 and does not identify an unfinished issue blocking T21.
- Baseline `npm run typecheck` and `npm run build` pass before T21 edits.
- Implemented `DingTalkReplySink` using `sessionWebhook` for text and Markdown payloads, with Markdown title derivation, code-fence balancing, webhook expiry/missing checks, and safe failure logging.
- Wired `DingTalkAdapter` to create a real reply sink by default while preserving injected fake sinks for local checks.
- Focused local checks pass for text/Markdown payloads, missing/expired webhook errors, HTTP failure handling, token-safe logs, and adapter default sink dispatch.
- Final validation passes: `npm run typecheck`, `npm run build`, and `npm run fake:message -- "/state" "/cc ." "hello fake backend" "/close"`.
- Marked T21 as `[DONE]` in `TODO.md` with the completion record.
