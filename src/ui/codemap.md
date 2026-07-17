# src/ui/

Presentation layer for the **pi-dag-tasks** extension. Two distinct concerns sharing no runtime state:
1. **Tool renderers** (`tool-render.ts`) — format `task` (mutation) and `task_query` (read) tool calls and results into themed Pi-TUI `Text`/`Spacer` nodes shown in the agent's transcript view.
2. **Live status widget** (`widget.ts`) — `DagTaskWidget`, a persistent component placed `aboveEditor` in the Pi TUI that mirrors the task list (counts, in_progress task with elapsed time, blocked-task rows) and self-updates while any task is in progress.

Both are pure view code: they read from `DagTaskStore`/`config` and from tool `details` payloads, never mutate state. All rendering is theme-driven (`theme.fg(color, text)`, `strikethrough`).

## Design
- **Theme-bound output.** Everything rendered returns Pi-TUI primitives (`Text`, `Spacer` from `@earendil-works/pi-tui`) and colors via `Theme` (`@earendil-works/pi-coding-agent`). Semantic color tokens: `accent`, `success`, `warning`, `error`, `dim`, `muted`, `toolTitle`.
- **Collapsed vs expanded.** Result renderers accept `{ expanded }`; collapsed shows a minimal summary (header + operations), expanded appends a full task snapshot / archive history. `renderCall` for both tools returns `Spacer(0)` to suppress the input echo.
- **Scope branching (query).** `renderTaskQueryResult` dispatches on `details.scope`: `history` → archive list; `current` → current snapshot; `ready` → "Next tasks" with in_progress/ready/blocked (blocked hidden when collapsed).
- **Widget two-mode layout.** Full mode (≤8 tasks) lists every task; compact mode (>8) keeps the 2 most-recent completed plus all open, collapsing the rest into `+N open`.
- **Elapsed-time freeze.** The widget stamps `displayNow` only inside `update()`, so incidental TUI re-renders (e.g. loader spinner) do not tick the elapsed clock each second; the animation interval (120ms when `animateActiveTasks`) re-runs `update()` to refresh it.

## Flow
- **Mutation result (`task`):** `renderTaskResult` reads `TaskResultDetails` → `manageHeader(action)` title → loops `operations` through `renderOperationLine` (+ `renderOperationWarnings`); if `expanded` and tasks present, appends "Current state" via `renderTaskSnapshot`, then optional `guidance`.
- **Query result (`task_query`):** `renderTaskQueryResult` reads `TaskQueryResultDetails` and branches on `scope` (`history`/`current`/`ready`) as described above.
- **Widget:** `update()` (the single refresh entry point) reads `store.list()`, writes the status string, (de)registers the widget + timer, then asks the TUI to render; the registered factory calls `render(width)` each cycle.

## Integration
- **Consumed by** the tool registration in `src/index.ts`: renderers wired as `renderCall`/`renderResult` on the `task` tool (index.ts L641–642) and `task_query` tool (L692–693); imported at index.ts L18–21.
- **Widget lifecycle** owned by `src/index.ts`: constructed `new DagTaskWidget(store, () => cfg)` (L356); `setStore` on store rebuild (L396); `setHost` with `ctx.ui.setStatus` + `client.widgets` (L407); `update()` after init (L409); `dispose()` on extension teardown (L478); `markActive` fired from the `task` handler on every in_progress transition (L563, 576, 578, 581, 597, 606, 616) and the interactive command menu (L753–755).
- **Depends on:** `../store.js` (`DagTaskStore` — widget reads `list()`), `../types.js` (`DagTask`, `DagTasksConfig`, `TaskResultDetails`, `TaskQueryResultDetails`, `TaskOperation`, `TaskOperationKind`, `ArchivedDagTask`), `@earendil-works/pi-tui`, `@earendil-works/pi-coding-agent`, `pi-extension-utils` (`UtilsClient["widgets"]`, `setStatus`).

---

## tool-render.ts

**Responsibility:** Renders `task` and `task_query` tool calls/results for the agent's transcript. Call renderers suppress input echo (`Spacer(0)`); result renderers produce a themed `Text` with a header, per-operation event-log lines, and (when expanded) a task-state snapshot or archive history. Falls back to the raw result text when no structured `details` payload is present, and detects/forwards tool-error text via `looksLikeToolError`.

**Key exports** (all consumed in `src/index.ts` tool registration):
- `renderTaskCall(_args, _theme)` — `Spacer(0)`; suppresses mutation call echo.
- `renderTaskResult(result, { expanded }, theme)` — header via `manageHeader(action)`; per-operation lines (`renderOperationLine` + `renderOperationWarnings`); expanded → `renderTaskSnapshot` under "Current state" + `guidance`.
- `renderTaskQueryCall(_args, _theme)` — `Spacer(0)`; suppresses query call echo.
- `renderTaskQueryResult(result, { expanded }, theme)` — branches on `details.scope`: `history` → `renderArchiveSnapshot`; `current` → `renderTaskSnapshot`; `ready` → "Next tasks" header + in_progress/ready/(blocked-if-expanded) lines.

**Private helpers:** theme/markup — `toolMarker`, `insetText`, `looksLikeToolError`, `renderFallbackResult`; headers — `renderHeaderFromCounts`, `renderHeader`; task lines — `openBlockers`, `renderTaskIcon`, `renderDependencyHint`, `renderTaskLine`; operations — `operationIcon` (`TaskOperationKind`→glyph: skipped `!`/purged `−`/archived `◌`/started `◼`/completed `✔`/unblocked `◻`), `operationVerb`, `manageHeader`, `renderOperationLine`, `renderOperationWarnings`; snapshots — `renderTaskSnapshot` (header + `limit` task lines, `+N more`), `renderArchiveSnapshot`.

**Constants:** `HEADER_INDENT=" "`, `ROW_INDENT="  "`, `DETAIL_INDENT="    "`, `SECTION_RULE="────────────"`. **Interface:** `RenderResultLike { content?, details?, isError? }`.

**Integration points:** Imported and wired in `src/index.ts` (L18–21) to the `task` (L641–642) and `task_query` (L692–693) tool `renderCall`/`renderResult`. The `{ expanded }` flag is supplied by the Pi render context (controls full snapshot vs. collapsed summary). Types from `../types.js`.

## widget.ts

**Responsibility:** `DagTaskWidget` — a persistent Pi-TUI status component (placement `aboveEditor`, order 20) showing live task progress: a compact `Tasks · X/Y done · A archived · K in_progress` header, per-task rows (icon + `#id` + title/activeForm, elapsed time for in-progress, "blocked by #x, #y" hints, strikethrough for completed), collapsing to a compact layout when the list exceeds 8 rows. Self-refreshes while any task is `in_progress`; when the current list empties, it remains visible as `Tasks · A archived`.

**Key export:**
- `class DagTaskWidget` — `constructor(store: DagTaskStore, config: () => DagTasksConfig = () => ({}))`.
  - `setStore(store)`, `setHost(host: WidgetHost)` — late-binding injectors (host exposes `setStatus(key, text)` + `widgets`).
  - `markActive(_id, _active)` — re-render trigger; effectively delegates to `update()`. Called by `src/index.ts` on every in_progress transition.
  - `update()` — single refresh entry point: computes status string (`tasks N/M open · A archived · K in_progress` → `setStatus(WIDGET_KEY)`), registers the widget factory once, manages the animation timer, advances `frame`, requests a render. No-op until `host` is set.
  - `dispose()` — stops timer, removes widget, clears status.
  - `private render(width, theme)` — full layout (≤ `MAX_BODY_ROWS`) or compact (>8: keeps `COMPACT_COMPLETED_ROWS=2` most-recent completed + all open, collapsing older open tasks into `+N open`).
  - `private renderTask(task, theme)` — row formatter: icon, id, title/activeForm, `formatDuration(displayNow - startedAt)` for in_progress, blocked-by hint, strikethrough for completed.
  - `private ensureTimer()` / `stopTimer()` — `setInterval` at `120ms` when `config().animateActiveTasks` else `30_000ms`.
- **Top-level helpers:** `formatDuration(ms)`, `findLastIndex(items, predicate)`.

**Constants:** `WIDGET_KEY="dag-tasks"`, `WIDGET_PLACEMENT="aboveEditor"`, `WIDGET_ORDER=20`, `SPINNER` (11-glyph array; defined for in_progress-task animation), `MAX_BODY_ROWS=8`, `COMPACT_COMPLETED_ROWS=2`. **Interfaces:** `ThemeLike { fg, strikethrough }`, `WidgetHost { setStatus, widgets }`.

**Integration points:**
- Reads `DagTaskStore.list()`/`archivedCount()` (`../store.js`) and `DagTasksConfig.animateActiveTasks` (`../types.js`) each refresh; writes the status line via `WidgetHost.setStatus` and registers itself through `UtilsClient["widgets"]` (`pi-extension-utils`).
- Lifecycle owned by `src/index.ts`: construct L356, `setStore` L396, `setHost` L407, `update` L409, `dispose` L478; `markActive` invoked across the `task` handler (L563, 576, 578, 581, 597, 606, 616) and the interactive command menu (L753–755).
- Render output is plain pre-themed strings fed to Pi-TUI `truncateToWidth` per line.
