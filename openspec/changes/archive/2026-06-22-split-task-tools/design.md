## Context

`pi-dag-tasks` currently exposes one mutation tool (`task_manage`, 8 actions) and one read tool (`task_next`). Reads are split: `list`/`history` live in `task_manage`, while `next` (ready tasks) is a separate tool. The mutation tool carries singular and batch variants of every input (`create`/`creates`, `update`/`updates`, top-level `id` vs `update.id`), which is the root cause of agent misuse — e.g. `{ action: "update", id: "1", update: { status } }` fails schema validation with "update.id: must have required properties id". The store layer (`src/store.ts`) and DAG model are sound; the problem is the LLM-facing tool surface.

## Goals / Non-Goals

**Goals:**
- One canonical input shape per concept: every action is batch-only with a single array field.
- A clean mutate/query boundary so each tool has a small, coherent field set and no read fields leak into the mutation tool.
- Collapse redundant actions (`complete` = update; `done_archive` = complete+archive; `list`/`history`/`next` → one query tool with a scope).
- Preserve all current behavior (dependencies, auto-archive, verification metadata, context durability, reminder/widget integration) under the new surface.

**Non-Goals:**
- Changing the DAG dependency model, edge semantics, or cycle/self-reference validation.
- Changing the on-disk storage format or store internals beyond what the new actions require.
- Changing widget rendering UX or auto-archive policy; only tool-name plumbing is in scope.
- Providing a runtime alias/compatibility shim for old tool/action names.

## Decisions

**1. Split into two tools along mutate/query, not consolidate into one.**
A single tool would carry `creates`/`updates`/`ids` alongside `limit`/`query`/`scope` — the original "many unrelated fields" problem. Mutate/query split gives each tool a coherent field set, and the read tool is the high-frequency, idempotent orientation call that deserves its own trivial surface.
*Alternatives considered:* (a) keep one tool, drop singular variants only — leaves read and mutation fields mixed; (b) one tool with a union `operations` array of discriminated entries — rejected because heterogeneous entries are harder for an LLM to fill correctly than a uniform array plus an action enum.

**2. Batch-only inputs; remove singular `create`/`update` and the top-level `id`.**
A single task is an array of one. `update.id` is required in every entry; there is no top-level `id` for updates, so there is exactly one place an id can live. This removes the entire id-placement confusion class.
*Alternative considered:* "allow miswrites" — make `update.id` optional and fall back to top-level `id`. Rejected because it preserves ambiguity rather than removing it; the user redirected to a clean redesign.

**3. Fold `complete` and `done_archive` into `update`.**
Completing is `update` with `status: "completed"`. This removes two actions that were thin wrappers over `update` and removes the only reason `ids` had to carry a status transition.
*Alternatives considered:* (a) keep `complete` — redundant with `update`; (b) a generic `transition { to }` action — adds indirection; the misuse was never about action names, it was about id placement.

**4. `archive_all` as an explicit action, not an `archive: "completed"` flag.**
Keeps `archive` uniform (it only acts on `ids`) and gives "archive every completed task" its own verb. Distinct intent (reversible bulk archiving) deserves a distinct action.
*Alternative considered:* `archive` accepting an optional `archive: "completed"` modifier — rejected by the user; conflates two behaviors and complicates the `archive` schema.

**5. `task_query` with a `scope` enum folding `list`/`history`/`next`.**
`scope: "ready" | "active" | "history"` unifies all reads behind one field. `ready` is the old `task_next`; `active` is the old `list`; `history` is the old `history`. No unions, one shape.
*Alternative considered:* retain `task_next` as a separate tool — rejected; keeps the read surface fragmented across two tools for no reason.

## Risks / Trade-offs

- **[BREAKING tool/action names]** Any external caller invoking `task_manage`/`task_next` must migrate. → Mitigation: this is a versioned extension package with a controlled LLM surface; document the migration in README and bump version. Rollback is `git revert`.
- **[Tool-name-keyed logic]** Reminder publishing and cooldown logic reference `task_manage`/`task_next` by name. → Mitigation: update `TOOL_NAMES` and the cooldown set to `task`/`task_query`; covered by tests.
- **[High-frequency call rename]** `task_next` → `task_query` changes the orientation call agents make every turn. → Mitigation: `task_query` with `scope: "ready"` produces equivalent output and guidance; update prompt snippets.
- **[Loss of `done_archive` convenience]** One-call complete+archive becomes two calls. → Mitigation: cheap and sequential; `archive_all` covers the common "finish and sweep" flow.

## Migration Plan

In-place rewrite in the same package (no staged rollout): implement the two tools, migrate all internal references (reminder/widget/render/command layers), update tests, then document the new surface in README. Deploy as a version bump. Rollback is `git revert` of the implementation commit.
