# pi-dag-tasks

Lean unified task manager for the Pi coding agent. In Pi, tasks are the todo/progress list.

Design goal: keep the LLM tool surface small while preserving dependency-aware task tracking, verification nudges, and durable progress across compression.

## Tools

Only two LLM-callable tools are exposed:

- `task_manage` — Pi's single task/todo tracker for batch CRUD/status/dependency/archive/history operations
  - actions: `create`, `update`, `complete`, `archive`, `purge`, `list`, `history`
  - use `action: "create"` for both single `create` and batch `creates`; there is no `action: "creates"`
  - supports batch fields: `creates`, `updates`, `ids`
  - dependency fields: `blockedBy`, `blocks`, `addBlockedBy`, `addBlocks`, `removeBlockedBy`, `removeBlocks`; values must be task IDs like `"1"`, not task titles
  - `context` field preserves durable handoff instructions and outcomes across compression; add context to pending tasks up front, then update it as decisions/outcomes emerge
  - for tests, builds, lint, typecheck, manual review, or output inspection tasks, prefer `metadata.kind: "verification"`
  - create accepts initial `status`, so one call can create multiple tasks with one or more already `in_progress`
- `task_next` — compact summary plus ready/unblocked tasks, including context for active/ready tasks

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

Example batch completion:

```json
{
  "action": "complete",
  "ids": ["1", "2", "3", "4", "5"]
}
```

Example archive and history lookup:

```json
{ "action": "archive", "archive": "completed" }
```

```json
{ "action": "history", "limit": 20, "query": "verification" }
```

History is compact by default. Add `"includeContext": true` when you want archived task context:

```json
{ "action": "history", "limit": 20, "includeContext": true }
```

Use `purge` only for true destructive removal from the active DAG. Completed work should usually be archived, not purged.

## Task sizing

Use the smallest task list that preserves quality:

- no task list for straightforward work, roughly the easiest 25%, single-step work, pure answers, or work under 3 trivial steps
- use a task list for 3+ distinct steps, non-trivial multi-action work, dependencies, ambiguity, checkpoints, multiple user requests, discovered follow-up work, or durable intent across turns/compression
- size the task list to the actual work; there is no maximum task count
- use as many tasks as needed for clarity, dependencies, and checkpoints, including 20+ tasks for long or complex processes
- avoid compressing genuinely distinct work into an artificial 6-8 task range
- use dependencies only when they change what can start next
- start with the smallest useful task list and expand it as exploration reveals real subwork

## UI

Inspired by `tintinweb/pi-tasks`, but smaller:

- persistent widget above the editor
- status icons: `✔` completed, `◼` in progress, `◻` pending
- strikethrough completed items
- spinner for active `in_progress` tasks with elapsed time
- Claude-like compact mode for long lists: summarize completed items, show the first open tasks, then `+N pending`
- compact footer status
- `/tasks` interactive command for view/create/archive/history/settings; archived tasks are viewable even when no active tasks remain

## Task context

Each task can include optional `context`: durable handoff instructions, rationale, constraints, decisions, and outcomes that should survive conversation compression. Keep titles short, descriptions actionable, and put the execution-critical details in `context` for non-trivial work.

For pending tasks, write context up front with constraints, relevant findings, expected inputs, dependencies, and definition of done. As work progresses, update context with decisions and outcomes so archived tasks become a useful work log.

Tiny process/meta instructions such as "compress context", "reply concisely", "run final check", or "summarize changes" should usually go into the relevant task's context or definition of done, not become standalone tasks, unless they are a real multi-step workflow phase.

Context is intentionally rendered selectively:

- ephemeral reminders include context for the active task only
- `task_next` includes context for active and ready tasks
- the persistent widget stays compact and does not show full context

## Reminder behavior

The extension publishes compact persistent task reminder intents to `pi-reminders` when active tasks exist. `pi-reminders` writes them as durable `<system-reminder>` history messages when task state changes and repeats them every 10 turns. The reminder leads with open-work counts and points to ready work, but it does not force immediate archival when work is complete; completed tasks can remain visible while awaiting user review. It does not include the full DAG or archive history. Use `task_next`, `task_manage({"action":"list"})`, or `task_manage({"action":"history"})` for details.

When all tasks are complete, the reminder nudges verification before finalization and archival. If there are 3+ completed tasks and no verification signal is recorded, it adds a deterministic nudge. The strongest signal is `metadata.kind: "verification"`; the fallback scans task title, description, context, active form, and metadata JSON for terms such as test, verify, check, review, lint, typecheck, build, compile, validate, smoke test, manual test, and qa.

## Storage

Config file: `.pi/dag-tasks/dag-tasks-config.json`

Storage modes:

- `memory` — no files
- `session` — `.pi/dag-tasks/tasks-<sessionId>.json` default
- `project` — `.pi/dag-tasks/tasks.json`

Archived tasks are appended to `.pi/dag-tasks/archive.jsonl` and are available through `task_manage` with `action: "history"`. History is shown newest-first with archive time and reason (`manual archive` or `completed sweep`). Archived context is hidden by default; pass `includeContext: true` for detailed history.

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
