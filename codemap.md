# Repository Atlas: pi-dag-tasks

## Project Responsibility
A lean **DAG task manager extension** for the Pi coding agent. It is Pi's single task/todo tracker: exposes exactly two LLM-callable tools — `task` (all mutations, batch-only) and `task_query` (all reads, scope-based) — backed by a per-session file store with dependency edges (blocks/blockedBy), a persistent TUI status widget, periodic state reminders, turn-delayed auto-archive of completed work, and an interactive `/tasks` command. Working memory for the in_progress execution slice; not a roadmap/milestone planner (that's `pi-charter`).

## System Entry Points
- `src/index.ts` — sole extension export (`export default dagTasksExtension(pi)`); registers the two tools, the `/tasks` command, lifecycle event handlers, the reminder system, and the widget.
- `package.json` — `pi.extensions: ["./src/index.ts"]` registers the extension; `pi-dag-tasks` is a `pi-package`.
- `tsconfig.json` — strict ES2022/NodeNext, `noEmit` (consumed directly by Pi/Bun).

## Tool Surface (the contract)
- `task` — mutations: `action` ∈ {`create`, `update`, `archive`, `archive_all`, `purge`}. Batch-only: `create`→`creates[]`, `update`→`updates[]` (`id` required per entry), `archive`/`purge`→`ids[]`, `archive_all`→no args. Completing a task = `update` with `status:"completed"`. `additionalProperties:false` (no singular fields, no top-level `id`).
- `task_query` — reads: `scope` ∈ {`ready`, `current`, `history`} + `limit?`/`query?`/`includeCompleted?`(default true)/`includeContext?`(default false). `ready` = unblocked pending + in_progress + summary.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `src/` | Core: extension entry point, store (persistence + DAG), types, config, auto-archive. Schemas + handlers for both tools. | [View Map](src/codemap.md) |
| `src/ui/` | Presentation only: tool-call/result renderers (`tool-render.ts`) for the transcript view, and the live `aboveEditor` status widget (`widget.ts`). | [View Map](src/ui/codemap.md) |

## Key External Dependencies
- `@earendil-works/pi-coding-agent` — extension API, theme, commands.
- `@earendil-works/pi-tui` — TUI primitives (`Text`, `Spacer`).
- `@earendil-works/pi-ai` — `StringEnum` schema helper.
- `typebox` — runtime schema definitions (`Type.Object`, `Value.Check`).
- `pi-extension-utils` — `connect` (utils client: reminders, widgets), logger, widget coordinator.

## Persistence Layout
Each session owns one versioned file:
- `.pi/dag-tasks/tasks-<sessionId>.json` — `{version: 1, tasks: Record<id, task>}` containing active and archived records; IDs derive from the highest key.
- Archived records carry `archived: {at, reason}` in the same task object. There is no shared archive or project/global/custom-path mode.
- `.pi/dag-tasks/dag-tasks-config.json` — `autoArchiveCompleted`, `animateActiveTasks`.
- Legacy task arrays migrate on the next mutation; unsupported files are backed up. Writes use atomic `tmp`+`rename` under a PID-stale `.lock` (40ms×125 retry).

## Specification (OpenSpec)
- `openspec/specs/task-mutations/spec.md` — 7 requirements defining the `task` tool contract.
- `openspec/specs/task-queries/spec.md` — 5 requirements defining the `task_query` tool contract.
- `openspec/changes/archive/2026-06-22-split-task-tools/` — the change that split the old single `task_manage`+`task_next` into the current two-tool surface (design decisions + rejected alternatives preserved).

## Testing & Verification
- `bun test` — unit/integration tests (`tests/`). `bun run typecheck` — `tsc --noEmit`.
- `openspec validate <spec>` — validates spec structure.
