import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ArchivedDagTask, DagTask, StoreData, TaskStatus } from "./types.js";

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
  owner?: string | null;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
}

export class DagTaskStore {
  private nextId = 1;
  private tasks = new Map<string, DagTask>();
  private lockPath?: string;
  private archivePath?: string;

  constructor(private filePath?: string) {
    if (!filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    this.lockPath = `${filePath}.lock`;
    this.archivePath = `${dirname(filePath)}/archive.jsonl`;
    this.load();
  }

  setFilePath(filePath: string | undefined): void {
    this.filePath = filePath;
    this.lockPath = filePath ? `${filePath}.lock` : undefined;
    this.archivePath = filePath ? `${dirname(filePath)}/archive.jsonl` : undefined;
    this.nextId = 1;
    this.tasks.clear();
    if (filePath) {
      mkdirSync(dirname(filePath), { recursive: true });
      this.load();
    }
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8")) as StoreData;
      this.nextId = data.nextId || 1;
      this.tasks = new Map((data.tasks || []).map((task) => [task.id, task]));
    } catch {
      this.nextId = 1;
      this.tasks.clear();
    }
  }

  private save(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const data: StoreData = { nextId: this.nextId, tasks: [...this.tasks.values()] };
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

  list(): DagTask[] {
    if (this.filePath) this.load();
    return [...this.tasks.values()].sort((a, b) => Number(a.id) - Number(b.id));
  }

  get(id: string): DagTask | undefined {
    if (this.filePath) this.load();
    return this.tasks.get(id);
  }

  create(input: { title: string; description?: string; context?: string; status?: TaskStatus; activeForm?: string; blockedBy?: string[]; blocks?: string[]; owner?: string; metadata?: Record<string, unknown> }): { task: DagTask; warnings: string[] } {
    return this.withLock(() => {
      const now = Date.now();
      const task: DagTask = {
        id: String(this.nextId++),
        title: input.title,
        description: input.description ?? "",
        context: input.context,
        status: input.status ?? "pending",
        activeForm: input.activeForm,
        owner: input.owner,
        blocks: [],
        blockedBy: [],
        metadata: input.metadata ?? {},
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      const warnings = this.applyEdges(task.id, input.blocks, input.blockedBy);
      return { task, warnings };
    });
  }

  update(patch: TaskPatch): { task?: DagTask; changed: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.tasks.get(patch.id);
      if (!task) return { changed: [], warnings: [`#${patch.id} not found`] };
      const changed: string[] = [];
      if (patch.title !== undefined) { task.title = patch.title; changed.push("title"); }
      if (patch.description !== undefined) { task.description = patch.description; changed.push("description"); }
      if (patch.context !== undefined) { task.context = patch.context || undefined; changed.push("context"); }
      if (patch.status !== undefined) { task.status = patch.status; changed.push("status"); }
      if (patch.activeForm !== undefined) { task.activeForm = patch.activeForm; changed.push("activeForm"); }
      if (patch.owner !== undefined) { task.owner = patch.owner ?? undefined; changed.push("owner"); }
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
      task.updatedAt = Date.now();
      return { task, changed: [...new Set(changed)], warnings };
    });
  }

  archive(ids: string[], reason: ArchivedDagTask["archiveReason"] = "selected"): number {
    return this.withLock(() => {
      const archived: ArchivedDagTask[] = [];
      for (const id of ids) {
        const task = this.tasks.get(id);
        if (!task) continue;
        archived.push({ archivedAt: Date.now(), archiveReason: reason, task });
        this.tasks.delete(id);
      }
      this.appendArchive(archived);
      this.removeDanglingEdges();
      return archived.length;
    });
  }

  archiveCompleted(): number {
    const ids = this.list().filter((task) => task.status === "completed").map((task) => task.id);
    return this.archive(ids, "completed");
  }

  purge(ids: string[]): number {
    return this.withLock(() => {
      let count = 0;
      for (const id of ids) {
        if (this.tasks.delete(id)) count++;
      }
      this.removeDanglingEdges();
      return count;
    });
  }

  history(limit = 20, query?: string): ArchivedDagTask[] {
    if (!this.archivePath || !existsSync(this.archivePath)) return [];
    const normalizedQuery = query?.toLowerCase();
    const records = readFileSync(this.archivePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArchivedDagTask)
      .filter((record) => {
        if (!normalizedQuery) return true;
        return [record.task.title, record.task.description, record.task.context ?? ""]
          .join("\n")
          .toLowerCase()
          .includes(normalizedQuery);
      });
    return records.slice(-limit).reverse();
  }

  ready(): DagTask[] {
    return this.list().filter((task) => task.status === "pending" && this.openBlockers(task).length === 0);
  }

  openBlockers(task: DagTask): string[] {
    return task.blockedBy.filter((id) => this.tasks.get(id)?.status !== "completed");
  }

  deleteFileIfEmpty(): void {
    if (!this.filePath || this.tasks.size > 0) return;
    try { unlinkSync(this.filePath); } catch {}
  }

  private appendArchive(records: ArchivedDagTask[]): void {
    if (!this.archivePath || records.length === 0) return;
    mkdirSync(dirname(this.archivePath), { recursive: true });
    appendFileSync(this.archivePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  }

  private removeDanglingEdges(): void {
    const valid = new Set(this.tasks.keys());
    for (const task of this.tasks.values()) {
      task.blocks = task.blocks.filter((id) => valid.has(id));
      task.blockedBy = task.blockedBy.filter((id) => valid.has(id));
    }
  }

  private applyEdges(id: string, blocks?: string[], blockedBy?: string[]): string[] {
    const task = this.tasks.get(id);
    if (!task) return [`#${id} not found`];
    const warnings: string[] = [];
    for (const targetId of blocks ?? []) {
      const target = this.tasks.get(targetId);
      if (targetId === id) { warnings.push(`#${id} cannot block itself`); continue; }
      if (!target) { warnings.push(`dependency #${targetId} does not exist; use task IDs like '1', not task titles`); continue; }
      if (this.hasPath(targetId, id)) { warnings.push(`cycle between #${id} and #${targetId}`); continue; }
      if (!task.blocks.includes(targetId)) task.blocks.push(targetId);
      if (!target.blockedBy.includes(id)) target.blockedBy.push(id);
    }
    for (const blockerId of blockedBy ?? []) {
      const blocker = this.tasks.get(blockerId);
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
    const task = this.tasks.get(fromId);
    return task?.blocks.some((nextId) => this.hasPath(nextId, toId, visited)) ?? false;
  }

  private removeEdges(id: string, blocks?: string[], blockedBy?: string[]): void {
    const task = this.tasks.get(id);
    if (!task) return;
    for (const targetId of blocks ?? []) {
      task.blocks = task.blocks.filter((x) => x !== targetId);
      const target = this.tasks.get(targetId);
      if (target) target.blockedBy = target.blockedBy.filter((x) => x !== id);
    }
    for (const blockerId of blockedBy ?? []) {
      task.blockedBy = task.blockedBy.filter((x) => x !== blockerId);
      const blocker = this.tasks.get(blockerId);
      if (blocker) blocker.blocks = blocker.blocks.filter((x) => x !== id);
    }
  }
}
