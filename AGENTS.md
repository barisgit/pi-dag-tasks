# pi-dag-tasks

## Contracts

- Exactly two LLM tools: batch-only `task` mutations (`creates[]`, `updates[]`, `ids[]`) and scoped `task_query` reads. No singular top-level mutation fields. Tactical working memory belongs here; durable outcomes belong in pi-charter.
- Each session owns `.pi/dag-tasks/tasks-<sessionId>.json`, version 1, with active and archived records together. IDs derive from the highest key, including archived records. Settings are project-local in `.pi/dag-tasks/dag-tasks-config.json`.
- `blockedBy` is canonical; reverse `blocks` edges are derived. Validate cycles, self-blocking and missing dependencies per edge and retain warnings.
- The store has no Pi dependency; the extension owns reminders and turn-delayed archive policy. Reads reload disk; mutations lock, load, mutate, atomically rename a temporary file, and unlock. Lock retries are bounded and stale-PID aware. Legacy arrays migrate only on mutation; unsupported files are backed up. Never delete an archive-only file.
- Reminders need both turn and time thresholds, with task-tool cooldown suppression. Auto-archive countdowns reset when completed work reopens or new work changes the batch.
- UI is read-only. Widget snapshots refresh on mutation/lifecycle `update()` (or store replacement), not render or animation ticks. Elapsed time is frozen between updates/ticks; incidental redraws do not advance it. Full mode keeps all rows up to eight; compact mode keeps the two most recent completed rows in original order and summarizes omitted open work. Archive-only sessions keep their archive count visible.

## Verification

Run `bun test` and `bun run typecheck`. OpenSpec tool contracts live under `openspec/specs/`.
