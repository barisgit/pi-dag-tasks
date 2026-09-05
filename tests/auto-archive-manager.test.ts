import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoArchiveManager } from "../src/auto-clear.js";
import { DagTaskStore } from "../src/store.js";

test("per-task autoarchive preserves work reopened before the mutation lock", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-per-task-reopen-"));
  const taskFile = join(root, "tasks.json");
  const store = new DagTaskStore(taskFile);
  const peer = new DagTaskStore(taskFile);
  const manager = new AutoArchiveManager(() => store, () => "on_task_complete");
  const write = fs.writeFileSync;
  let interleaved = false;
  let lockWrite: ReturnType<typeof spyOn> | undefined;
  try {
    store.create({ title: "Reopened", status: "completed" });
    store.create({ title: "Later completion", status: "completed" });
    store.create({ title: "Untracked completion", status: "completed" });
    store.create({ title: "Blocked", blockedBy: ["2"] });
    manager.trackCompletion("1", 0);
    manager.trackCompletion("2", 1);
    expect(manager.onTurnStart(3)).toBe(false);
    expect(peer.history()).toEqual([]);

    // Commit a peer reopen after the manager's status read, immediately before
    // its archive lock acquisition. The public store update performs a real write.
    lockWrite = spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
      if (path === `${taskFile}.lock` && !interleaved) {
        interleaved = true;
        peer.update({ id: "1", status: "pending" });
      }
      return write(path, data, options);
    });
    const archived = manager.onTurnStart(4);
    expect(interleaved).toBe(true);
    expect(peer.get("1")?.status).toBe("pending");
    expect(archived).toBe(false);
    expect(peer.history()).toEqual([]);

    expect(manager.onTurnStart(5)).toBe(true);
    expect(peer.list().map((task) => task.id)).toEqual(["1", "3", "4"]);
    expect(peer.history().map((entry) => [entry.task.id, entry.archiveReason])).toEqual([["2", "selected"]]);
    expect(peer.get("4")?.blockedBy).toEqual([]);
    expect(fs.existsSync(`${taskFile}.lock`)).toBe(false);
    expect(manager.onTurnStart(6)).toBe(false);
    expect(store.archive(["1"])).toBe(1);
    expect(peer.history().find((entry) => entry.task.id === "1")?.archiveReason).toBe("selected");
  } finally {
    lockWrite?.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
