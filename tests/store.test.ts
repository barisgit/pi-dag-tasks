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
});
