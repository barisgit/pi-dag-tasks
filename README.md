# pi-dag-tasks

Lean unified task manager for the Pi coding agent. In Pi, tasks are the todo/progress list.

Design goal: keep the LLM tool surface small while preserving dependency-aware execution tracking, verification nudges, and durable progress across compression. `pi-dag-tasks` is working memory for the active execution slice; durable roadmap planning, milestones, acceptance criteria, and evidence gates belong in `pi-charter`.

Use tasks for durable state, not ceremony. Create the smallest useful task set for the current execution slice: meaningful outcomes that can be started, blocked, completed, or verified. Avoid giant roadmap clones, speculative future work, and microscopic process tasks such as opening a file, editing one string, or replying to the user.

## Tools

Only two LLM-callable tools are exposed:

- `task` — all mutations. Batch-only inputs; each action reads exactly one field.
  - actions: `create`, `update`, `archive`, `archive_all`, `purge`
  - `create` → `creates: [{ title, status?, blockedBy?, blocks?, context?, owner?, metadata? }]`
  - `update` → `updates: [{ id, status?, title?, context?, activeForm?, owner?, metadata?, addBlockedBy?, addBlocks?, removeBlockedBy?, removeBlockedBy? }]` — `id` is required in every entry
  - `archive` / `purge` → `ids: ["1", "2"]`
  - `archive_all` → no arguments (archives every completed task)
  - completing a task is `update` with `status: "completed"`; there is no separate `complete` action
  - dependency fields: `blockedBy`/`blocks` (on create) and `addBlockedBy`/`addBlocks`/`removeBlockedBy`/`removeBlocks` (on update); values must be task IDs like `"1"`, not titles
  - `context` field preserves durable setup across compression; write it up front and update it only when durable new information changes how the task should be done or the original context is wrong/incomplete
  - for tests, builds, lint, typecheck, manual review, or output inspection tasks, prefer `metadata.kind: "verification"`
  - create accepts initial `status`, so one call can create multiple tasks with one or more already `in_progress`
- `task_query` — all reads, selected by `scope`
  - scopes: `ready` (unblocked pending + active tasks, plus a summary), `active` (the current list, including completed unless `includeCompleted: false`), `history` (archived tasks, newest first)
  - optional: `limit`, `query`, `includeCompleted` (default `true`), `includeContext` (default `false`)

There are no singular `create`/`update` fields and no top-level `id`; pass a single item as a one-element array.

Example create-and-start in one call. The second task can use `blockedBy: ["1"]` because IDs are assigned sequentially within the batch:

```json
{
  "action": "create",
  "creates": [
    { "title": "Inspect implementation", "status": "in_progress", "context": "Preserve the user's intent while testing." },
    { "title": "Run verification", "blockedBy": ["1"] }
  ]
}
```

Example batch update (also how you complete tasks):

```json
{
  "action": "update",
  "updates": [
    { "id": "1", "status": "in_progress" },
    { "id": "2", "status": "completed" }
  ]
}
```

Example archive all completed tasks, then look them up:

```json
{ "action": "archive_all" }
```

```json
{ "scope": "history", "query": "verification" }
```

History is compact by default. Add `"includeContext": true` when you want archived task context:

```json
{ "scope": "history", "includeContext": true }
```

Use `purge` only for true destructive removal from the active DAG. Completed work should usually be archived, not purged; archive once it is ready to leave the active review surface.

## Task sizing

Use the smallest task list that preserves quality:

- no task list for straightforward work, roughly the easiest 25%, single-step work, pure answers, or work under 3 trivial steps
- use a task list for 3+ distinct steps, non-trivial multi-action work, dependencies, ambiguity, checkpoints, multiple user requests, discovered follow-up work, or durable intent across turns/compression
- size the task list to the active execution slice, not the whole roadmap
- if a charter owns milestones or acceptance criteria, do not duplicate that plan in tasks; create only the next actionable slice
- use as many tasks as needed for clarity, dependencies, and checkpoints within that slice
- avoid both giant charter clones and artificial 6-8 task ranges
- use dependencies only when they change what can start next
- keep statuses current as work finishes; avoid batching completions at the end
- only mark tasks completed when the work is fully done, including verification when appropriate
- prefer ready tasks in ID order when multiple tasks are available
- start with the smallest useful task list and expand it as exploration reveals real subwork

## UI

Inspired by `tintinweb/pi-tasks`, but smaller:

- persistent widget above the editor
- compact header: `Tasks · M/N done · X active`
- status icons: `✔` completed, `◼` in progress, `◻` pending, `◫` blocked
- strikethrough completed items
- static in-progress rows with elapsed time by default; optional spinner animation via config
- compact mode preserves task order, drops completed rows from the body first, then appends `+N open` if unfinished rows still do not fit
- compact footer status
- `/tasks` interactive command for view/create/archive/history/settings; archived tasks are viewable even when no active tasks remain

## Task context

Each task can include optional `context`: durable handoff instructions, rationale, constraints, decisions, and definition of done that should survive conversation compression. Keep titles short, descriptions actionable, and put the execution-critical setup in `context` for non-trivial work.

For pending tasks, write context up front with constraints, relevant findings, expected inputs, dependencies, and definition of done. Treat context as durable setup, not a running journal or brainstorming scratchpad. Update it only when durable new information changes how the task should be done, or when the original context is wrong/incomplete; otherwise capture live progress in status changes, tool results, commits, or the final summary.

Tiny process/meta instructions such as "compress context", "reply concisely", "run final check", or "summarize changes" should usually go into the relevant task's context or definition of done, not become standalone tasks, unless they are a real multi-step workflow phase.

Context is intentionally rendered selectively:

- ephemeral reminders include context for the active task only
- `task_query` (scope `ready` or `active`) includes context for active and ready tasks
- the persistent widget stays compact and does not show full context

## Reminder behavior

`task` mutation results include a concise `Next:` guidance line derived from the resulting task state, so the agent gets immediate local direction without relying on a reminder.

The extension publishes compact persistent task reminder intents via `pi-extension-utils` reminder events as fallback guidance for long chains of work. The reminder utilities write them as durable `<system-reminder>` history messages and repeat unchanged task reminders every 15 turns. After `task` or `task_query`, the extension removes the cached task reminder and suppresses task reminder publishing for 5 turns because the tool result already gives the agent fresh task context. The reminder leads with open-work counts, shows how long the current active task has been running, points to ready work, and keeps task hygiene visible without restating the full task-management policy. When all tasks are complete, it nudges verification and archival once tasks are ready to leave the active review surface. It does not include the full DAG or archive history. Use `task_query` with `scope:"ready"`, `scope:"active"`, or `scope:"history"` for details.

When all tasks are complete, the reminder nudges verification before finalization and archival. If completed tasks are ready for user review or no longer need to stay visible, archive them. If there are 3+ completed tasks and no verification signal is recorded, it adds a deterministic nudge. The strongest signal is `metadata.kind: "verification"`; the fallback scans task title, description, context, active form, and metadata JSON for terms such as test, verify, check, review, lint, typecheck, build, compile, validate, smoke test, manual test, and qa.

## Storage

Config file: `.pi/dag-tasks/dag-tasks-config.json`

Storage modes:

- `memory` — no files
- `session` — `.pi/dag-tasks/tasks-<sessionId>.json` default
- `project` — `.pi/dag-tasks/tasks.json`

Widget animation is disabled by default. Set `animateActiveTasks: true` in the config file to animate in-progress task icons; static in-progress tasks still show elapsed time from the persisted `startedAt` timestamp.

Archived tasks are appended to `.pi/dag-tasks/archive.jsonl` and are available through `task_query` with `scope: "history"`. History is shown newest-first with archive time and reason (`manual archive` or `completed sweep`). Archived context is hidden by default; pass `includeContext: true` for detailed history.

Override with `PI_DAG_TASKS`:

- `off` — memory mode
- `name` — `~/.pi/dag-tasks/name.json`
- `/abs/path.json` — explicit file
- `./relative.json` — relative to cwd

File-backed modes use a simple lock file and atomic rename writes.

## Install/dev

```bash
npm install
npm run typecheck
pi -e ./src/index.ts
```

Or add the package path to Pi settings/packages once published.

## Out of scope

Subagent execution/cascade is intentionally omitted. The extension only tracks and surfaces ready work.
