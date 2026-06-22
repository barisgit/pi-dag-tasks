## 1. Types and store readiness

- [x] 1.1 In `src/types.ts`, replace `TaskManageAction` with a mutation action union (`create | update | archive | archive_all | purge`) and add a `TaskQueryScope` union (`ready | active | history`); split `TaskManageResultDetails`/`TaskNextResultDetails` into `TaskResultDetails` (mutations) and `TaskQueryResultDetails` (reads).
- [x] 1.2 Confirm `src/store.ts` already provides `archiveCompleted()` for `archive_all` and the ready/history helpers used by `task_query`; add nothing if present.

## 2. Schemas and tool registration

- [x] 2.1 In `src/index.ts`, define `TaskParams` (`action`, `creates`, `updates`, `ids` only — no singular `create`/`update`, no top-level `id`) and `TaskQueryParams` (`scope`, `limit`, `query`, `includeCompleted`, `includeContext`); require `id` in every `updates` entry.
- [x] 2.2 Register two tools named `task` and `task_query` with `description`, `promptSnippet`, and `promptGuidelines` describing the batch-only, action→field mapping and completion-via-update behavior.
- [x] 2.3 Implement the `task` handler covering `create`, `update` (status:completed replaces complete), `archive` (ids only), `archive_all` (no args), and `purge`; reject unknown actions.
- [x] 2.4 Implement the `task_query` handler mapping `ready`→unblocked+active+summary, `active`→current list, `history`→archived (newest first, `limit`/`query`); honor `includeCompleted` and `includeContext`.

## 3. Tool-name-aware layers

- [x] 3.1 Update `TOOL_NAMES` and any reminder cooldown/publishing logic keyed off `task_manage`/`task_next` to use `task`/`task_query`.
- [x] 3.2 Update widget auto-archive trigger references that key off tool names.

## 4. Renderers

- [x] 4.1 In `src/ui/tool-render.ts`, replace `renderTaskManageCall/Result` and `renderTaskNextCall/Result` with `renderTaskCall/Result` and `renderTaskQueryCall/Result`; keep event-log rendering for mutation operations and snapshot rendering for query results.

## 5. Documentation

- [x] 5.1 Rewrite the README Tools section for the two-tool surface (`task` + `task_query`), the action→field map, and examples for create-and-start, batch update, completion-via-update, archive/archive_all, and query scopes.

## 6. Tests

- [x] 6.1 Update `tests/tool-render.test.ts` to the new tool names and renderers; cover mutation event-log rows and query snapshots.
- [x] 6.2 Update `tests/store.test.ts` to remove obsolete singular-update references and add coverage for batch-only id resolution errors, `archive_all`, and dependency edge add/remove.
- [x] 6.3 Add coverage that removed actions (`complete`, `done_archive`, `list`, `history`, `next`) and singular fields (`create`, `update`, top-level `id`) are rejected.

## 7. Verification

- [x] 7.1 Run `bun run typecheck` and `bun test`; ensure both pass with the new surface.
- [x] 7.2 Confirm the change validates (`openspec validate split-task-tools`) and every requirement has a passing scenario or test.
