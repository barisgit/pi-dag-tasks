# task-queries Specification

## Purpose
TBD - created by archiving change split-task-tools. Update Purpose after archive.
## Requirements
### Requirement: Query tool surface

The system SHALL expose exactly one read tool named `task_query` that performs all task reads. Reads SHALL be selected by a `scope` field with values `ready`, `active`, and `history`. The system SHALL NOT expose `task_next`, `list`, or `history` as separate tools or mutation actions.

#### Scenario: Each scope is accepted
- **WHEN** a caller invokes `task_query` with `scope` set to `ready`, `active`, or `history`
- **THEN** the corresponding read is returned

#### Scenario: Invalid scope is rejected
- **WHEN** a caller invokes `task_query` with a scope other than ready, active, or history
- **THEN** the call fails validation

### Requirement: ready scope

The `ready` scope SHALL return unblocked `pending` tasks and `in_progress` tasks, plus a compact summary including total and completed counts. A pending task with at least one open dependency SHALL be reported as blocked, not ready.

#### Scenario: Ready and blocked tasks are distinguished
- **WHEN** task 1 is pending with no open blockers, task 2 is pending blocked by task 1, and task 3 is in_progress
- **THEN** `scope: "ready"` lists task 1 as ready and task 3 as active, and reports task 2 as blocked

### Requirement: active scope

The `active` scope SHALL return the current (non-archived) task list, including completed tasks unless `includeCompleted` is false.

#### Scenario: Active list includes completed by default
- **WHEN** the active list contains pending, in_progress, and completed tasks and `scope: "active"` is invoked with default options
- **THEN** all non-archived tasks are returned, including completed ones

### Requirement: history scope

The `history` scope SHALL return archived tasks, newest first, honoring `limit` and `query`. The `query` string SHALL match against archived task titles and descriptions.

#### Scenario: History search by query
- **WHEN** archived tasks exist and `scope: "history", query: "verification"` is invoked
- **THEN** only archived tasks matching "verification" are returned, newest first

### Requirement: Query filtering

`task_query` SHALL accept `limit`, `query`, `includeCompleted` (default true), and `includeContext` (default false). `includeContext` SHALL include each task's durable `context` in the output for ready/active scopes when true.

#### Scenario: Context included on request
- **WHEN** `scope: "active", includeContext: true` is invoked and a task has context set
- **THEN** the task's context is included in the returned output

