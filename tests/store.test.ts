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
});
