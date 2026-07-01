import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
      expect(data.tasks.map((task: { title: string }) => task.title)).toEqual([
        "Before deletion",
        "After deletion",
      ]);
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