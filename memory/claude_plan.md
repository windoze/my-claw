# Execution Plan

## Current objective

Complete exactly the first incomplete task in `TODO.md`, then stop after documenting and committing the result.

Selected task: `T04 [DONE] 实现路径解析和目录白名单策略`.

## Plan

1. Confirm the latest commit message does not mention unfinished work directly relevant to T04.
2. Inspect the current config, schema, utility, and security modules that T04 will touch.
3. Implement reusable path helpers in `src/utils/path.ts`: home expansion, user-path resolution, directory realpath/stat checks, and normalized containment checks.
4. Implement `PathPolicy` in `src/security/PathPolicy.ts` so allowed roots are realpathed once and directory validation reports distinct errors for missing paths, non-directories, and paths outside the allowlist.
5. Integrate path normalization and default environment allowlist validation into `src/config/loadConfig.ts`.
6. Export any new public utilities through existing module indexes, following current project structure.
7. Run `npm run typecheck`, `npm run build`, and focused manual validation for `~` expansion, allowlist rejection, symlink escape rejection, and legal directory acceptance.
8. Fix any observed unscheduled failures before marking T04 done.
9. Mark `T04` as `[DONE]` in `TODO.md` and add a completion record with validation details.
10. Commit all task-related changes with a descriptive T04 commit message and the required co-author trailer.

## Progress

- Read `TODO.md`; the first incomplete task is `T04 [TODO] 实现路径解析和目录白名单策略`.
- Wrote this execution plan before implementation commands or code changes for T04.
- Latest commit is `[T03] Implement config loading and validation`; it does not mention unfinished work relevant to T04.
- Baseline validation passed before source changes: `npm run typecheck` and `npm run build`.
- Implemented path utilities, `PathPolicy`, config-file path expansion, config path normalization, and public security/utils exports.
- Validation passed after source changes: `npm run typecheck`, `npm run build`, and focused runtime checks for home expansion, config-path home expansion, relative resolution, allowlist acceptance/rejection, missing paths, non-directories, and symlink escape rejection.
- Marked `T04` as `[DONE]` in `TODO.md` with a completion record.
