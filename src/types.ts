export type TaskStatus = "pending" | "in_progress" | "completed";

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

export type TaskManageAction = "create" | "update" | "complete" | "archive" | "purge" | "list" | "history";
