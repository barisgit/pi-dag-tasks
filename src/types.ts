export type TaskStatus = "pending" | "in_progress" | "completed";

/** Actions accepted by the `task` mutation tool. */
export type TaskMutationAction = "create" | "update" | "archive" | "archive_all" | "purge";

/** Read scopes accepted by the `task_query` tool. */
export type TaskQueryScope = "ready" | "current" | "history";

export type TaskOperationKind =
  | "created"
  | "started"
  | "completed"
  | "updated"
  | "unblocked"
  | "archived"
  | "purged"
  | "skipped";

export interface TaskOperation {
  kind: TaskOperationKind;
  id?: string;
  title?: string;
  count?: number;
  total?: number;
  changed?: string[];
  warnings?: string[];
}

export type ArchiveReason = "completed" | "selected";

export interface DagTask {
  id: string;
  title: string;
  description: string;
  context?: string;
  status: TaskStatus;
  activeForm?: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

export interface StoredDagTask {
  title: string;
  status: TaskStatus;
  createdAt: number;
  description?: string;
  context?: string;
  activeForm?: string;
  blockedBy?: string[];
  metadata?: Record<string, unknown>;
  startedAt?: number;
  completedAt?: number;
  archived?: { at: number; reason: ArchiveReason };
}

export interface StoreData {
  version: 1;
  tasks: Record<string, StoredDagTask>;
}

/** Result details for the `task` mutation tool. */
export interface TaskResultDetails {
  action?: TaskMutationAction;
  operations: TaskOperation[];
  tasks?: DagTask[];
  guidance?: string;
}

/** Result details for the `task_query` read tool. Fields vary by `scope`. */
export interface TaskQueryResultDetails {
  scope: TaskQueryScope;
  ready?: DagTask[];        // scope "ready": unblocked pending tasks
  inProgress?: DagTask[];   // scope "ready": in_progress tasks
  blocked?: DagTask[];      // scope "ready": pending tasks with open blockers
  tasks?: DagTask[];        // scope "current": the current (non-archived) list
  history?: ArchivedDagTask[]; // scope "history": archived tasks, newest first
  completedCount?: number;
  totalCount?: number;
}

export interface ArchivedDagTask {
  archivedAt: number;
  archiveReason: ArchiveReason;
  task: DagTask;
}

export interface DagTasksConfig {
  autoArchiveCompleted?: "never" | "on_list_complete" | "on_task_complete";
  animateActiveTasks?: boolean;
}
