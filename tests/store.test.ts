import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DagTaskStore } from "../src/store.js";

describe("DagTaskStore", () => {
  test("recreates the storage directory if it is deleted after initialization", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-store-"));
    try {
      const piDir = join(root, ".pi");
      const taskFile = join(piDir, "dag-tasks", "tasks-session.json");
      const store = new DagTaskStore(taskFile);

      store.create({ title: "Before deletion" });
      rmSync(piDir, { recursive: true, force: true });

      expect(() => store.create({ title: "After deletion" })).not.toThrow();
      expect(existsSync(taskFile)).toBe(true);

      const data = JSON.parse(readFileSync(taskFile, "utf8"));
      expect(Object.values(data.tasks).map((task: any) => task.title)).toEqual([
        "Before deletion",
        "After deletion",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refreshes archived tasks before a concurrent store creates a task", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-concurrent-archive-"));
    try {
      const taskFile = join(root, "tasks.json");
      const first = new DagTaskStore(taskFile);
      const stale = new DagTaskStore(taskFile);

      first.create({ title: "Archived elsewhere" });
      first.archive(["1"]);
      first.deleteFileIfEmpty();

      expect(stale.archivedCount()).toBe(1);
      expect(stale.create({ title: "New task" }).task.id).toBe("2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps archives isolated to their session file", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-session-archive-"));
    try {
      const first = new DagTaskStore(join(root, "tasks-first.json"));
      const second = new DagTaskStore(join(root, "tasks-second.json"));
      first.create({ title: "First session only" });
      first.archive(["1"]);

      expect(first.archivedCount()).toBe(1);
      expect(second.archivedCount()).toBe(0);
      expect(second.history()).toEqual([]);
      expect(existsSync(join(root, "archive.jsonl"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stores archived tasks in the session file and derives the next ID", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-archive-id-"));
    try {
      const taskFile = join(root, "tasks.json");
      const store = new DagTaskStore(taskFile);
      store.create({ title: "Archived" });
      store.archive(["1"]);
      store.deleteFileIfEmpty();

      expect(existsSync(taskFile)).toBe(true);
      const data = JSON.parse(readFileSync(taskFile, "utf8"));
      expect(data.version).toBe(1);
      expect(data.nextId).toBeUndefined();
      expect(data.tasks["1"].id).toBeUndefined();
      expect(data.tasks["1"].archived).toEqual({ at: expect.any(Number), reason: "selected" });

      const reloaded = new DagTaskStore(taskFile);
      expect(reloaded.create({ title: "New task" }).task.id).toBe("2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("migrates the legacy task array to the versioned object schema", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-migrate-"));
    try {
      const taskFile = join(root, "tasks.json");
      writeFileSync(taskFile, JSON.stringify({ nextId: 99, tasks: [{ id: "7", title: "Legacy", description: "", status: "pending", owner: "unused-agent", blocks: [], blockedBy: [], metadata: {}, createdAt: 10, updatedAt: 20 }] }));

      const store = new DagTaskStore(taskFile);
      expect(store.list().map((task) => task.id)).toEqual(["7"]);
      expect(store.create({ title: "After migration" }).task.id).toBe("8");

      const data = JSON.parse(readFileSync(taskFile, "utf8"));
      expect(data.version).toBe(1);
      expect(Object.keys(data.tasks)).toEqual(["7", "8"]);
      expect(data.tasks["7"]).toEqual({ title: "Legacy", status: "pending", createdAt: 10 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("backs up an unsupported store version before starting fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-version-"));
    try {
      const taskFile = join(root, "tasks.json");
      writeFileSync(taskFile, JSON.stringify({ version: 99, tasks: {} }));

      const store = new DagTaskStore(taskFile);
      expect(store.list()).toEqual([]);
      store.create({ title: "Fresh" });

      expect(readdirSync(root).some((name) => name.startsWith("tasks.json.unsupported-"))).toBe(true);
      expect(JSON.parse(readFileSync(taskFile, "utf8")).version).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reports the cumulative archived count after reload", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-archive-count-"));
    try {
      const taskFile = join(root, "tasks.json");
      const store = new DagTaskStore(taskFile);
      store.create({ title: "Archived A" });
      store.create({ title: "Archived B" });
      store.archive(["1", "2"]);

      expect(new DagTaskStore(taskFile).archivedCount()).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists start and completion timestamps from task status", () => {
    const store = new DagTaskStore();

    const created = store.create({ title: "Running", status: "in_progress" }).task;
    expect(typeof created.startedAt).toBe("number");
    expect(created.completedAt).toBeUndefined();

    const startedAt = created.startedAt;
    const completed = store.update({ id: created.id, status: "completed" }).task;
    expect(completed?.startedAt).toBe(startedAt);
    expect(typeof completed?.completedAt).toBe("number");

    const reset = store.update({ id: created.id, status: "pending" }).task;
    expect(reset?.startedAt).toBeUndefined();
    expect(reset?.completedAt).toBeUndefined();
  });

  test("archiveCompleted archives every completed task (archive_all backing)", () => {
    const store = new DagTaskStore();
    store.create({ title: "Open", status: "pending" });
    store.create({ title: "Done A", status: "completed" });
    store.create({ title: "Done B", status: "completed" });

    const count = store.archiveCompleted();

    expect(count).toBe(2);
    // Only completed tasks are swept; the open one remains.
    expect(store.list().map((t) => t.title)).toEqual(["Open"]);
  });

  test("archiveCompleted records archived tasks to history when file-backed", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-archive-"));
    try {
      const taskFile = join(root, "tasks.json");
      const store = new DagTaskStore(taskFile);
      store.create({ title: "Done A", status: "completed" });
      store.create({ title: "Done B", status: "completed" });

      store.archiveCompleted();

      // Archived tasks are newest-first in history.
      expect(store.history(100).map((r) => r.task.title)).toEqual(["Done B", "Done A"]);
      expect(store.history(100)[0]?.task).not.toHaveProperty("archived");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("update add/remove dependency edges by id", () => {
    const store = new DagTaskStore();
    store.create({ title: "A" });
    store.create({ title: "B" });

    const added = store.update({ id: "2", addBlockedBy: ["1"] }).task;
    expect(added?.blockedBy).toEqual(["1"]);
    expect(store.get("1")?.blocks).toEqual(["2"]);
    expect(store.openBlockers(added!)).toEqual(["1"]);

    const removed = store.update({ id: "2", removeBlockedBy: ["1"] }).task;
    expect(removed?.blockedBy).toEqual([]);
    expect(store.openBlockers(removed!)).toEqual([]);
  });

  test("update on a missing id reports not found, not a thrown error", () => {
    const store = new DagTaskStore();
    const result = store.update({ id: "99", status: "in_progress" });
    expect(result.task).toBeUndefined();
    expect(result.warnings).toEqual(["#99 not found"]);
  });

  test("ready() returns unblocked pending tasks", () => {
    const store = new DagTaskStore();
    store.create({ title: "Free" });
    store.create({ title: "Blocked", blockedBy: ["1"] });
    store.create({ title: "In progress", status: "in_progress" });

    expect(store.ready().map((t) => t.title)).toEqual(["Free"]);
  });
});