import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import dagTasksExtension from "../src/index.ts";

test("always persists active tasks in the current session file", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-session-storage-"));
  const previousOverride = process.env.PI_DAG_TASKS;
  const legacyGlobalPath = join(root, "legacy-global.json");
  process.env.PI_DAG_TASKS = legacyGlobalPath;

  try {
    const configDir = join(root, ".pi", "dag-tasks");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "dag-tasks-config.json"), JSON.stringify({ taskScope: "project" }));
    expect(loadConfig(root)).toEqual({});

    let taskTool: any;
    dagTasksExtension({
      events: { emit() {}, on() {} },
      on() {},
      registerCommand() {},
      registerTool(tool: any) { if (tool.name === "task") taskTool = tool; },
    } as any);

    const ctx = {
      cwd: root,
      hasUI: false,
      sessionManager: { getSessionId: () => "current-session" },
    } as any;
    await taskTool.execute(
      "create",
      { action: "create", creates: [{ title: "Session task" }] },
      new AbortController().signal,
      () => {},
      ctx,
    );

    expect(existsSync(join(configDir, "tasks-current-session.json"))).toBe(true);
    expect(existsSync(join(configDir, "tasks.json"))).toBe(false);
    expect(existsSync(legacyGlobalPath)).toBe(false);
  } finally {
    if (previousOverride === undefined) delete process.env.PI_DAG_TASKS;
    else process.env.PI_DAG_TASKS = previousOverride;
    rmSync(root, { recursive: true, force: true });
  }
});
