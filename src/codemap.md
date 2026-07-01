# src/

## Responsibility
Core implementation of **pi-dag-tasks**, a lean DAG task manager extension for the Pi coding agent. It exposes exactly two LLM tools — `task` (mutations) and `task_query` (reads) — backed by an optional file-persisted store (memory, per-session, or per-project), plus a status-line widget, a periodic state reminder, auto-archive of completed work, and an interactive `/tasks` command.

## Design
- **Two-tool contract.** All mutations funnel through `task` (`create`/`update`/`archive`/`archive_all`/`purge`, batch-only via `creates[]`/`updates[]`/`ids[]`); all reads funnel through `task_query` (`scope` = `ready`/`current`/`history`). No singular mutation fields.
- **Dependency graph.** Tasks carry `blocks`/`blockedBy` edges kept in sync bidirectionally by `store.ts`. Edge application runs cycle detection (`hasPath` DFS), self-block, and missing-dependency checks, emitting per-edge `warnings`.
- **Store layering.** `DagTaskStore` is pure data + locking; it knows nothing of Pi. `index.ts` owns lifecycle, config, reminders, UI, and the auto-archive policy.
- **Locking.** File-backed stores use a PID-stale `.lock` file with synchronous retry (40ms × 125). Reads (`list`/`get`/`history`) reload from disk; writes go through `withLock` (load → mutate → atomic `tmp`+`rename` save → unlock).
- **Reminders.** A state reminder fires on `context`/`turn_start` when enough turns *and* wall-clock time have elapsed since the last task-tool call; tool calls/results suppress it for a cooldown.

## Flow
1. Extension loads (`dagTasksExtension`) → in-memory `DagTaskStore` created; config/store path resolved lazily.
2. `session_start`/`context`/`turn_start` → `ensureStore(ctx)` resolves scope (env `PI_DAG_TASKS`, else `cfg.taskScope` `memory`/`session`/`project`) and calls `store.setFilePath(...)`.
3. `turn_start` → `autoArchive.onTurnStart()` may archive completed tasks after a turn delay; `publishTaskReminder()` may push a state reminder.
4. `tool_call`/`tool_result` for `task`/`task_query` → `suppressTaskReminder()` (cooldown). `task` completions call `autoArchive.trackCompletion()`.
5. `task` execute → dispatch by `action` → `store.create/update/archive/archiveCompleted/purge`, accumulate `TaskOperation[]` + unblock detection, append `buildTaskManageGuidance`, refresh UI.
6. `task_query` execute → `scope` branch → `store.ready()`/`list()`/`history()` → formatted text + `TaskQueryResultDetails`.
7. `/tasks` command → interactive menu (view/create/history/settings) backed by the same store.

## Integration
- Registered with Pi via `export default dagTasksExtension(pi: ExtensionAPI)` in `src/index.ts`.
- External deps: `@earendil-works/pi-coding-agent` (`ExtensionAPI`, contexts), `@earendil-works/pi-ai` (`StringEnum`), `typebox` (`Type`), `pi-extension-utils` (`connect`, `createLogger`, `UtilsClient`, `ReminderIntent`).
- UI: `src/ui/tool-render.ts` (call/result renderers) and `src/ui/widget.ts` (`DagTaskWidget`) — own `src/ui/codemap.md`.
- Persistence: `.pi/dag-tasks/tasks-{sessionId}.json` (session), `.pi/dag-tasks/tasks.json` (project), `.pi/dag-tasks/archive.jsonl`, `.pi/dag-tasks/dag-tasks-config.json`. Override via `PI_DAG_TASKS` env (`off`/relative/absolute/`name`).
- Also exported as a Pi skill (`skills/openspec-*` and `pi-dag-tasks/skills` reference the same tools).

---

## Files

### `src/index.ts`
**Responsibility:** Extension entry point. Wires everything to Pi: registers the two tools and the `/tasks` command, manages lifecycle events, config/store resolution, the reminder system, the status widget, and auto-archive tracking. The default export `dagTasksExtension(pi)` is the registered extension.

**Key exports:**
- `export default function dagTasksExtension(pi: ExtensionAPI): void` (L351) — sole public surface; everything else is module-private.

**Key internals:**
- Schemas (typebox, `additionalProperties:false`): `TaskCreateSchema` (L53), `TaskUpdateSchema` (L65), `TaskParams` (L80: `action` + `creates`/`updates`/`ids`), `TaskQueryParams` (L87: `scope` + `limit`/`query`/`includeCompleted`/`includeContext`). Derived TS types `TaskParamsType`/`TaskQueryParamsType` (L95).
- Pure helpers (L49–209): `textResult`, `statusIcon`, `truncateText`, `formatDuration`, `inProgressTaskLabel`, `normalizeVerificationText`, `taskSearchText`, `hasVerificationSignal`, `shouldNudgeVerification`, `summarizeTasks`, `formatArchivedAt`, `archiveReasonLabel`, `summarizeHistory`, `countLabel`, `taskStatePrefix`, `buildTaskManageGuidance` (L211, the per-mutation "Next:" guidance), `reminderStateKey`, `buildReminder` (L253), `taskCounts`, `textHash`/`textPreview`, `logReminderDecision`, `taskReminderForgottenMs`, `taskReminderIntent`.
- Extension state (L351+): `cfg`, `store = new DagTaskStore()`, `logger`, `utilsClient`, `widget = new DagTaskWidget(...)`, `autoArchive = new AutoArchiveManager(() => store, () => cfg.autoArchiveCompleted ?? "on_list_complete", 4)`, plus turn/cooldown counters.
- Inner functions: `resolveCwd`, `refreshConfig`, `resolveStorePath` (env/scope → file path), `ensureStore`, `ensureUtilsClient`, `refreshUi`, `publishTaskReminder` (due = `turn >= nextReminderTurn && msSinceTaskTool >= taskReminderForgottenMs()`; `reminderStateKey` dedupe), `suppressTaskReminder`.
- Events: `session_start` (reset+ensure+refresh), `session_shutdown` (dispose), `context` (reminder unless cooldown), `turn_start` (increment turn, `autoArchive.onTurnStart`, refresh), `tool_call`/`tool_result` (suppress reminder on task tools).
- `pi.registerTool("task")` (L523): `renderShell:"self"`; `execute` dispatches create/update/archive/archive_all/purge, calls `autoArchive.trackCompletion`/`resetBatchCountdown`, detects newly-unblocked tasks, appends guidance; `renderCall: renderTaskCall`, `renderResult: renderTaskResult`.
- `pi.registerTool("task_query")` (L645): `scope` ready (in_progress + ready[+limit] + blocked + summary), in_progress (current list, `includeCompleted`), history (archived, `query` filter); `renderCall/Result` from `ui/tool-render.js`.
- `pi.registerCommand("tasks")` (L696): interactive menus (view/create/detail/history/settings); settings writes `cfg.autoArchiveCompleted` + `saveConfig`; Complete action → `store.update` + `autoArchive.trackCompletion`.

**Dependencies:** `./store.js` (`DagTaskStore`, `TaskPatch`), `./auto-clear.js` (`AutoArchiveManager`), `./config.js`, `./types.js`, `./ui/tool-render.js`, `./ui/widget.js`.

### `src/store.ts`
**Responsibility:** `DagTaskStore` — the data access layer. In-memory or file-backed task persistence, sequential ID allocation, bidirectional DAG edge management with cycle detection, archiving (JSONL append), and a stale-PID file lock. Knows nothing about Pi.

**Key exports:**
- `export class DagTaskStore` (~L57) — the store.
- `export interface TaskPatch` (L47) — update payload: `id` + optional `title`/`description`/`context`/`status`/`activeForm` (internal legacy storage/display only)/`owner`/`metadata` and edge deltas `addBlocks`/`addBlockedBy`/`removeBlocks`/`removeBlockedBy`. (Note: defined here, **not** in `types.ts`.)

**Public API:**
- `constructor(filePath?)` — if set, configures `lockPath = ${filePath}.lock`, `archivePath = ${dir}/archive.jsonl`, and `load()`s.
- `setFilePath(filePath?)` — reconfigure paths, reset, reload (used by `ensureStore`).
- `list()` → `DagTask[]` (sorted by numeric id; reloads if file-backed), `get(id)`.
- `create(input)` → `{task, warnings[]}` (auto-sets `startedAt`/`completedAt`).
- `update(patch)` → `{task?, changed[], warnings[]}` (status transitions, metadata merge/null-delete, edge add/remove).
- `archive(ids, reason="selected")` → count (appends to archive, removes dangling edges).
- `archiveCompleted()` → archives all `completed` with reason `completed`.
- `purge(ids)` → count (no archive record; removes dangling edges).
- `history(limit=20, query?)` → `ArchivedDagTask[]` newest-first, query filters title/description/context.
- `ready()` → pending tasks with no open blockers; `openBlockers(task)` → `blockedBy` not completed.
- `deleteFileIfEmpty()` — removes the (now empty) store file.

**Internals:** `load`/`save` (atomic tmp+rename), `withLock(fn)` (load→fn→save→unlock), `appendArchive`, `removeDanglingEdges`, `applyEdges` (cycle check, self-block, missing-dep warnings), `hasPath` (DFS reachability), `removeEdges`. Module-level `acquireLock`/`releaseLock`/`isProcessRunning`/`sleepSync` (retry 40ms × 125, stale-PID reaping via `process.kill(pid,0)`).

**Dependencies:** `node:fs`, `node:path`, `./types.js`.

### `src/types.ts`
**Responsibility:** Shared type definitions for the whole extension. No runtime code.

**Key exports (types):**
- Status/action enums: `TaskStatus` (`pending`|`in_progress`|`completed`), `TaskMutationAction`, `TaskQueryScope`, `TaskOperationKind`.
- `TaskOperation` (`kind`/`id`/`title`/`count`/`total`/`changed`/`warnings`) — per-action result unit returned by the `task` tool.
- `interface DagTask` — the core record (`id`, `title`, `description`, `context?`, `status`, `activeForm?`, `owner?`, `blocks[]`, `blockedBy[]`, `metadata`, `createdAt`, `startedAt?`, `completedAt?`, `updatedAt`).
- `StoreData` (`{nextId, tasks[]}`) — on-disk JSON shape.
- `TaskResultDetails` (`action?`, `operations[]`, `tasks?`, `guidance?`) — `task` tool structured result.
- `TaskQueryResultDetails` (`scope`, `ready?`/`inProgress?`/`blocked?`/`tasks?`/`history?`, `completedCount?`, `totalCount?`) — `task_query` structured result (fields vary by scope).
- `ArchivedDagTask` (`archivedAt`, `archiveReason` `completed`|`selected`, `task`).
- `DagTasksConfig` (`taskScope?`, `autoArchiveCompleted?`, `animateActiveTasks?`) — on-disk config.

**Dependencies:** none (pure types).

### `src/config.ts`
**Responsibility:** Tiny config loader/saver for `DagTasksConfig`. Resolves `.pi/dag-tasks/dag-tasks-config.json`.

**Key exports:**
- `configPath(cwd)` → `join(cwd, ".pi", "dag-tasks", "dag-tasks-config.json")`.
- `loadConfig(cwd)` → parsed `DagTasksConfig`, or `{}` on any read/parse error (fail-open).
- `saveConfig(config, cwd)` → `mkdirSync` (recursive) + `writeFileSync` JSON (2-space indent).

**Dependencies:** `node:fs`, `node:path`, `./types.js` (`DagTasksConfig`).

### `src/auto-clear.ts`
**Responsibility:** `AutoArchiveManager` — turn-delayed auto-archive policy. Decides *when* completed tasks get archived based on `cfg.autoArchiveCompleted`, without coupling to Pi events.

**Key exports:**
- `export type AutoArchiveMode = "never" | "on_list_complete" | "on_task_complete"`.
- `export class AutoArchiveManager` — `constructor(getStore, getMode, delayTurns = 4)`.

**API:**
- `trackCompletion(taskId, currentTurn)` — records completion: per-task map (`on_task_complete`) or checks the "all completed" countdown (`on_list_complete`).
- `resetBatchCountdown()` / `reset()` — clear the all-completed marker / all tracking (called on status regressions and resets).
- `onTurnStart(currentTurn)` → `boolean` — archives once `currentTurn - trackedTurn >= delayTurns` (per-task `store.archive([id])` or whole-list `store.archiveCompleted()`); returns whether anything was archived.
- private `checkAllCompleted(currentTurn)` — sets the all-completed countdown when every current task is `completed`.

**Dependencies:** `./store.js` (imports `DagTaskStore` type only). Driven by `index.ts`, which maps `cfg.autoArchiveCompleted` (`DagTasksConfig`, `types.ts`) onto `AutoArchiveMode` at construction and calls it from `turn_start` and the `task`/`/tasks` completion paths.
