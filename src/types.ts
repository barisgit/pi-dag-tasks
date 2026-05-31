export type TaskStatus = "pending" | "in_progress" | "completed";

export type TaskOperationKind =
  | "created"
  | "started"
  | "completed"
  | "done_archived"
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

export interface DagTask {
  id: string;
  title: string;
  description: string;
  context?: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  updatedAt: number;
}

export interface StoreData {
  nextId: number;
  tasks: DagTask[];
}

export interface TaskManageResultDetails {
  action?: TaskManageAction;
  operations: TaskOperation[];
  tasks?: DagTask[];
  history?: ArchivedDagTask[];
  guidance?: string;
}

export interface TaskNextResultDetails {
  ready: DagTask[];
  active: DagTask[];
  blocked: DagTask[];
  completedCount: number;
  totalCount: number;
}

export interface ArchivedDagTask {
  archivedAt: number;
  archiveReason: "completed" | "selected";
  task: DagTask;
}

export interface DagTasksConfig {
  taskScope?: "memory" | "session" | "project";
  autoArchiveCompleted?: "never" | "on_list_complete" | "on_task_complete";
  animateActiveTasks?: boolean;
}

export type TaskManageAction = "create" | "update" | "complete" | "done_archive" | "archive" | "purge" | "list" | "history";
