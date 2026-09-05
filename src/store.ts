import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ArchivedDagTask, DagTask, StoredDagTask, StoreData, TaskStatus } from "./types.js";

const LOCK_RETRY_MS = 40;
const LOCK_MAX_RETRIES = 125;

function sleepSync(ms: number): void {
  const start = Date.now();
  while (Date.now() - start < ms) {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      try {
        const pid = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
        if (pid && !isProcessRunning(pid)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {}
      sleepSync(LOCK_RETRY_MS);
    }
  }
  throw new Error(`Failed to acquire DAG task store lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch {}
}

export interface TaskPatch {
  id: string;
  title?: string;
  description?: string;
  context?: string;
  status?: TaskStatus;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
}

type TaskRecord = DagTask & { archived?: NonNullable<StoredDagTask["archived"]> };

type LegacyTask = DagTask & { owner?: string; updatedAt?: number };

export class DagTaskStore {
  private tasks = new Map<string, TaskRecord>();
  private lockPath?: string;

  constructor(private filePath?: string) {
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    this.lockPath = `${filePath}.lock`;
    this.load();
  }

  setFilePath(filePath: string | undefined): void {
    this.filePath = filePath;
    this.lockPath = filePath ? `${filePath}.lock` : undefined;
    this.tasks.clear();
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true });
      this.load();
    }
  }

  private fromStored(id: string, stored: StoredDagTask): TaskRecord {
    return {
      id,
      title: stored.title,
      description: stored.description ?? "",
      context: stored.context,
      status: stored.status,
      activeForm: stored.activeForm,
      blocks: [],
      blockedBy: stored.blockedBy ?? [],
      metadata: stored.metadata ?? {},
      createdAt: stored.createdAt,
      startedAt: stored.startedAt,
      completedAt: stored.completedAt,
      archived: stored.archived,
    };
  }

  private toStored(task: TaskRecord): StoredDagTask {
    const stored: StoredDagTask = {
      title: task.title,
      status: task.status,
      createdAt: task.createdAt,
    };
    if (task.description) stored.description = task.description;
    if (task.context) stored.context = task.context;
    if (task.activeForm) stored.activeForm = task.activeForm;
    if (task.blockedBy.length > 0) stored.blockedBy = task.blockedBy;
    if (Object.keys(task.metadata).length > 0) stored.metadata = task.metadata;
    if (task.startedAt !== undefined) stored.startedAt = task.startedAt;
    if (task.completedAt !== undefined) stored.completedAt = task.completedAt;
    if (task.archived) stored.archived = task.archived;
    return stored;
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<StoreData> & { tasks?: unknown };
      let entries: [string, StoredDagTask][];
      if (raw.version === 1 && raw.tasks && typeof raw.tasks === "object" && !Array.isArray(raw.tasks)) {
        entries = Object.entries(raw.tasks as Record<string, StoredDagTask>);
      } else if (Array.isArray(raw.tasks)) {
        entries = (raw.tasks as LegacyTask[]).map((task) => [task.id, task]);
      } else {
        throw new Error(`Unsupported DAG task store version: ${String(raw.version)}`);
      }
      this.tasks = new Map(entries.map(([id, task]) => [id, this.fromStored(id, task)]));
      this.rebuildDerivedEdges();
    } catch {
      this.tasks.clear();
      if (this.filePath && existsSync(this.filePath)) {
        renameSync(this.filePath, `${this.filePath}.unsupported-${Date.now()}`);
      }
    }
  }

  private save(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const data: StoreData = {
      version: 1,
      tasks: Object.fromEntries([...this.tasks].map(([id, task]) => [id, this.toStored(task)])),
    };
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  private activeTask(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id);
    return task?.archived ? undefined : task;
  }

  private nextTaskId(): string {
    const highest = [...this.tasks.keys()].reduce((max, id) => Math.max(max, Number(id) || 0), 0);
    return String(highest + 1);
  }

  list(): DagTask[] {
    if (this.filePath) this.load();
    return [...this.tasks.values()]
      .filter((task) => !task.archived)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  get(id: string): DagTask | undefined {
    if (this.filePath) this.load();
    return this.activeTask(id);
  }

  archivedCount(): number {
    if (this.filePath) this.load();
    return [...this.tasks.values()].filter((task) => task.archived).length;
  }

  create(input: { title: string; description?: string; context?: string; status?: TaskStatus; activeForm?: string; blockedBy?: string[]; blocks?: string[]; metadata?: Record<string, unknown> }): { task: DagTask; warnings: string[] } {
    return this.withLock(() => {
      const now = Date.now();
      const task: TaskRecord = {
        id: this.nextTaskId(),
        title: input.title,
        description: input.description ?? "",
        context: input.context,
        status: input.status ?? "pending",
        activeForm: input.activeForm,
        blocks: [],
        blockedBy: [],
        metadata: input.metadata ?? {},
        createdAt: now,
        startedAt: input.status === "in_progress" ? now : undefined,
        completedAt: input.status === "completed" ? now : undefined,
      };
      this.tasks.set(task.id, task);
      const warnings = this.applyEdges(task.id, input.blocks, input.blockedBy);
      return { task, warnings };
    });
  }

  update(patch: TaskPatch): { task?: DagTask; changed: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.activeTask(patch.id);
      if (!task) return { changed: [], warnings: [`#${patch.id} not found`] };
      const changed: string[] = [];
      if (patch.title !== undefined) { task.title = patch.title; changed.push("title"); }
      if (patch.description !== undefined) { task.description = patch.description; changed.push("description"); }
      if (patch.context !== undefined) { task.context = patch.context || undefined; changed.push("context"); }
      if (patch.status !== undefined) {
        task.status = patch.status;
        if (patch.status === "in_progress" && task.startedAt === undefined) task.startedAt = Date.now();
        if (patch.status === "pending") {
          task.startedAt = undefined;
          task.completedAt = undefined;
        }
        if (patch.status === "completed" && task.completedAt === undefined) task.completedAt = Date.now();
        changed.push("status");
      }
      if (patch.activeForm !== undefined) { task.activeForm = patch.activeForm; changed.push("activeForm"); }
      if (patch.metadata) {
        for (const [key, value] of Object.entries(patch.metadata)) {
          if (value === null) delete task.metadata[key];
          else task.metadata[key] = value;
        }
        changed.push("metadata");
      }
      const warnings = this.applyEdges(patch.id, patch.addBlocks, patch.addBlockedBy);
      if (patch.addBlocks?.length) changed.push("blocks");
      if (patch.addBlockedBy?.length) changed.push("blockedBy");
      this.removeEdges(patch.id, patch.removeBlocks, patch.removeBlockedBy);
      if (patch.removeBlocks?.length) changed.push("blocks");
      if (patch.removeBlockedBy?.length) changed.push("blockedBy");
      return { task, changed: [...new Set(changed)], warnings };
    });
  }

  archive(ids: string[], reason: ArchivedDagTask["archiveReason"] = "selected"): number {
    return this.withLock(() => this.archiveTasks(ids, reason));
  }

  archiveCompleted(ids?: string[], reason: ArchivedDagTask["archiveReason"] = "completed"): number {
    return this.withLock(() => {
      const completedIds = [...this.tasks.values()]
        .filter((task) => !task.archived && task.status === "completed" && (ids === undefined || ids.includes(task.id)))
        .map((task) => task.id);
      return this.archiveTasks(completedIds, reason);
    });
  }

  private archiveTasks(ids: string[], reason: ArchivedDagTask["archiveReason"]): number {
    let count = 0;
    const archivedAt = Date.now();
    for (const id of ids) {
      const task = this.activeTask(id);
      if (!task) continue;
      task.archived = { at: archivedAt, reason };
      count++;
    }
    this.removeDanglingEdges();
    return count;
  }

  purge(ids: string[]): number {
    return this.withLock(() => {
      let count = 0;
      for (const id of ids) {
        if (this.activeTask(id) && this.tasks.delete(id)) count++;
      }
      this.removeDanglingEdges();
      return count;
    });
  }

  history(limit = 20, query?: string): ArchivedDagTask[] {
    if (this.filePath) this.load();
    const normalizedQuery = query?.toLowerCase();
    return [...this.tasks.values()]
      .filter((task): task is TaskRecord & { archived: NonNullable<TaskRecord["archived"]> } => {
        if (!task.archived) return false;
        if (!normalizedQuery) return true;
        return [task.title, task.description, task.context ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .sort((a, b) => a.archived.at - b.archived.at || Number(a.id) - Number(b.id))
      .slice(-limit)
      .reverse()
      .map((record) => {
        const { archived, ...task } = record;
        return { archivedAt: archived.at, archiveReason: archived.reason, task };
      });
  }

  ready(): DagTask[] {
    return this.list().filter((task) => task.status === "pending" && this.openBlockers(task).length === 0);
  }

  openBlockers(task: DagTask): string[] {
    return task.blockedBy.filter((id) => this.activeTask(id)?.status !== "completed");
  }

  deleteFileIfEmpty(): void {
    if (!this.filePath || this.tasks.size > 0) return;
    try { unlinkSync(this.filePath); } catch {}
  }

  private removeDanglingEdges(): void {
    const activeIds = new Set([...this.tasks.values()].filter((task) => !task.archived).map((task) => task.id));
    for (const task of this.tasks.values()) {
      if (!task.archived) task.blockedBy = task.blockedBy.filter((id) => activeIds.has(id));
    }
    this.rebuildDerivedEdges();
  }

  private rebuildDerivedEdges(): void {
    for (const task of this.tasks.values()) task.blocks = [];
    for (const task of this.tasks.values()) {
      if (task.archived) continue;
      task.blockedBy = task.blockedBy.filter((id) => Boolean(this.activeTask(id)));
      for (const blockerId of task.blockedBy) {
        const blocker = this.activeTask(blockerId);
        if (blocker && !blocker.blocks.includes(task.id)) blocker.blocks.push(task.id);
      }
    }
  }

  private applyEdges(id: string, blocks?: string[], blockedBy?: string[]): string[] {
    const task = this.activeTask(id);
    if (!task) return [`#${id} not found`];
    const warnings: string[] = [];
    for (const targetId of blocks ?? []) {
      const target = this.activeTask(targetId);
      if (targetId === id) { warnings.push(`#${id} cannot block itself`); continue; }
      if (!target) { warnings.push(`dependency #${targetId} does not exist; use task IDs like '1', not task titles`); continue; }
      if (this.hasPath(targetId, id)) { warnings.push(`cycle between #${id} and #${targetId}`); continue; }
      if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
      if (!target.blockedBy.includes(id)) target.blockedBy.push(id);
    }
    for (const blockerId of blockedBy ?? []) {
      const blocker = this.activeTask(blockerId);
      if (blockerId === id) { warnings.push(`#${id} cannot block itself`); continue; }
      if (!blocker) { warnings.push(`dependency #${blockerId} does not exist; use task IDs like '1', not task titles`); continue; }
      if (this.hasPath(id, blockerId)) { warnings.push(`cycle between #${id} and #${blockerId}`); continue; }
      if (!task.blockedBy.includes(blockerId)) task.blockedBy.push(blockerId);
      if (!blocker.blocks.includes(id)) blocker.blocks.push(id);
    }
    return warnings;
  }

  private hasPath(fromId: string, toId: string, visited = new Set<string>()): boolean {
    if (fromId === toId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    const task = this.activeTask(fromId);
    return task?.blocks.some((nextId) => this.hasPath(nextId, toId, visited)) ?? false;
  }

  private removeEdges(id: string, blocks?: string[], blockedBy?: string[]): void {
    const task = this.activeTask(id);
    if (!task) return;
    for (const targetId of blocks ?? []) {
      task.blocks = task.blocks.filter((x) => x !== targetId);
      const target = this.activeTask(targetId);
      if (target) target.blockedBy = target.blockedBy.filter((x) => x !== id);
    }
    for (const blockerId of blockedBy ?? []) {
      task.blockedBy = task.blockedBy.filter((x) => x !== blockerId);
      const blocker = this.activeTask(blockerId);
      if (blocker) blocker.blocks = blocker.blocks.filter((x) => x !== id);
    }
  }
}
