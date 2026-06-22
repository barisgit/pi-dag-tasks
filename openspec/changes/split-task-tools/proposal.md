## Why

The single `task_manage` tool mixes mutation and read concerns, exposes both singular and batch input variants (`create`/`creates`, `update`/`updates`, top-level `id` vs `update.id`), and splits reads across `task_manage` (`list`, `history`) and `task_next` (`ready`). The singular-vs-batch and id-placement ambiguity is exactly what agents misuse — the validation error "update.id: must have required properties id" that triggered this work comes from agents reaching for the top-level `id` form. Two tools with one canonical batch shape each removes the entire confusion surface.

## What Changes

- **BREAKING**: Replace `task_manage` + `task_next` with two tools:
  - `task` — all mutations (create, update, archive, archive_all, purge)
  - `task_query` — all reads (scopes: `ready`, `active`, `history`)
- **BREAKING**: Batch-only inputs. Each action reads exactly one field:
  - `create` → `creates: [{ title, status?, blockedBy?, blocks?, context?, owner?, metadata? }] `
  - `update` → `updates: [{ id, status?, title?, context?, activeForm?, owner?, metadata?, addBlockedBy?, addBlocks?, removeBlockedBy?, removeBlockedBy? }] ` (`id` required in every entry; no top-level `id`)
  - `archive` / `purge` → `ids: ["1", "2"]`
  - `archive_all` → no arguments (archive every completed task)
  - `task_query` → `scope: "ready" | "active" | "history"` plus `limit?`, `query?`, `includeCompleted?`, `includeContext?`
- **BREAKING**: Remove actions `complete`, `done_archive`, `list`, `history`, `next`. Completing a task is now `update` with `status: "completed"`; `list`/`history`/`next` fold into `task_query` scopes.
- Add `archive_all` as an explicit action so the schema stays uniform (`archive` only acts on `ids), replacing the prior `archive: "completed"` flag option.
- Update tool-name-aware layers (reminder publishing, widget auto-archive triggers, command handler) to the new tool names.

## Capabilities

### New Capabilities
- `task-mutations`: the `task` tool — batch-only create/update/archive/archive_all/purge, action→field mapping, id resolution, DAG dependency edges, verification metadata, context durability on writes.
- `task-queries`: the `task_query` tool — read scopes (ready/active/history), filtering, ready/unblocked computation from dependency edges, the orientation role of queries.

### Modified Capabilities
<!-- None: openspec/specs/ is empty (first change). Both capabilities are specified fresh. -->

## Impact

- `src/index.ts`: rewrite tool registration (two `registerTool` calls), schemas (`TaskParams`, `TaskQueryParams`), action handlers, `TaskManageParamsType`, result-detail types, `TOOL_NAMES`, and the reminder cooldown/publishing logic that keys off tool names.
- `src/types.ts`: split/replace `TaskManageAction`, `TaskManageResultDetails`, `TaskNextResultDetails` into mutation vs query types; add `archive_all` action.
- `src/store.ts`: minimal — `archiveCompleted()` already exists for `archive_all`; no new mutation logic needed beyond the existing `create`/`update`/`archive`/`purge`/`history`.
- `src/ui/tool-render.ts`: split `renderTaskManageCall/Result` and `renderTaskNextCall/Result` into renderers for `task` and `task_query`.
- `README.md`: rewrite the Tools section for the two-tool surface and examples.
- `tests/`: update `tool-render.test.ts` and `store.test.ts` for the new surface; add coverage for batch-only id resolution, `archive_all`, and query scopes.
- External: any caller invoking `task_manage`/`task_next` by name (agent prompts, downstream packages) must migrate to `task`/`task_query`.
