# task-mutations Specification

## Purpose
TBD - created by archiving change split-task-tools. Update Purpose after archive.
## Requirements
### Requirement: Mutation tool surface

The system SHALL expose exactly one mutation tool named `task` whose actions are limited to `create`, `update`, `archive`, `archive_all`, and `purge`. The system SHALL NOT expose `complete`, `done_archive`, `list`, `history`, or `next` as mutation actions, and SHALL NOT expose a separate `task_next` tool.

#### Scenario: Each mutation action is accepted
- **WHEN** a caller invokes `task` with `action` set to one of `create`, `update`, `archive`, `archive_all`, `purge`
- **THEN** the action is executed

#### Scenario: Removed actions are rejected
- **WHEN** a caller invokes `task` with `action` set to `complete`, `done_archive`, `list`, `history`, or `next`
- **THEN** the call fails validation

### Requirement: Batch-only mutation inputs

Each `task` action SHALL read exactly one input field: `create` reads `creates`, `update` reads `updates`, `archive` and `purge` read `ids`, and `archive_all` reads no input field. The system SHALL NOT accept singular `create` or `update` fields.

#### Scenario: Single item is a one-element array
- **WHEN** a caller updates a single task with `updates: [{ id: "1", status: "in_progress" }]`
- **THEN** task 1 is updated to in_progress

#### Scenario: Singular fields are rejected
- **WHEN** a caller passes a singular `create` or `update` field, or a top-level `id`
- **THEN** the call fails validation

### Requirement: Update id resolution

Every entry in `updates` SHALL include an `id`. The `task` tool SHALL NOT accept a top-level `id` to fill a missing entry id. An update entry without an `id` SHALL be rejected.

#### Scenario: Batch update with per-entry ids
- **WHEN** a caller passes `updates: [{ id: "1", status: "in_progress" }, { id: "2", status: "completed" }]`
- **THEN** both tasks are updated to their respective statuses

#### Scenario: Missing entry id is an error
- **WHEN** a caller passes `updates: [{ status: "in_progress" }]`
- **THEN** the call fails with a message identifying the missing task id

### Requirement: Completion via update

Completing a task SHALL be performed with `action: "update"` and `status: "completed"`. Setting status to `completed` SHALL record the completion timestamp and clear the task's active marker.

#### Scenario: Update marks a task completed
- **WHEN** a caller passes `updates: [{ id: "3", status: "completed" }]`
- **THEN** task 3 is completed and a completion timestamp is recorded

### Requirement: archive_all action

The `archive_all` action SHALL archive every task whose status is `completed` without requiring an `ids` argument. The `archive` action SHALL act only on `ids` and SHALL NOT accept an archive-all flag.

#### Scenario: archive_all sweeps completed tasks
- **WHEN** a caller invokes `action: "archive_all"` and three tasks are completed
- **THEN** all three completed tasks are archived and an operation count is returned

#### Scenario: archive does not accept an archive-all modifier
- **WHEN** a caller invokes `action: "archive"` with an `archive: "completed"` flag instead of `ids`
- **THEN** the call fails validation

### Requirement: Create accepts initial status and dependencies

A `creates` entry SHALL accept an initial `status`, so a task can be created and started in one call. A `creates` entry SHALL accept `blockedBy` and `blocks` arrays of task IDs (not titles) to declare dependency edges at creation.

#### Scenario: Create-and-start in one call
- **WHEN** a caller passes `creates: [{ title: "Do thing", status: "in_progress" }]`
- **THEN** the task is created with status in_progress

#### Scenario: Declare dependencies by id at creation
- **WHEN** a caller passes `creates: [{ title: "A" }, { title: "B", blockedBy: ["1"] }]`
- **THEN** task B is created blocked by task A

### Requirement: Update dependency edges

An `updates` entry SHALL accept `addBlockedBy`, `addBlocks`, `removeBlockedBy`, and `removeBlocks` to mutate dependency edges by task id.

#### Scenario: Add and remove a dependency edge
- **WHEN** a caller passes `updates: [{ id: "2", addBlockedBy: ["1"] }]` then `updates: [{ id: "2", removeBlockedBy: ["1"] }]`
- **THEN** task 2 is first blocked by task 1, then unblocked

