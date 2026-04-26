# pi-dag-tasks

Lean DAG task/todo manager for the Pi coding agent.

Design goal: keep the LLM tool surface small while preserving dependency-aware task tracking.

## Tools

Only two LLM-callable tools are exposed:

- `task_manage` — batch CRUD/status/dependency/archive/history operations
  - actions: `create`, `update`, `complete`, `archive`, `purge`, `list`, `history`
  - use `action: "create"` for both single `create` and batch `creates`; there is no `action: "creates"`
  - supports batch fields: `creates`, `updates`, `ids`
  - dependency fields: `blockedBy`, `blocks`, `addBlockedBy`, `addBlocks`, `removeBlockedBy`, `removeBlocks`; values must be task IDs like `"1"`, not task titles
  - `context` field preserves durable handoff instructions and outcomes across compression; add context to pending tasks up front, then update it as decisions/outcomes emerge
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

The extension injects a compact ephemeral `<task-reminder>` into the latest visible context message before each LLM call when active tasks exist. It leads with open-work counts and points to ready work, but it does not force immediate archival when work is complete; completed tasks can remain visible while awaiting user review. It is not persisted as a session message and does not include the full DAG or archive history. Use `task_next`, `task_manage({"action":"list"})`, or `task_manage({"action":"history"})` for details.

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
