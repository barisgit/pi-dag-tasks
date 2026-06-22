import { describe, expect, test } from "bun:test";
import { Value } from "typebox/value";
import dagTasksExtension from "../src/index.ts";

function createMockPi() {
  const tools = new Map<string, any>();
  const pi = {
    events: { emit() {}, on() {} },
    on() {},
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
  };
  dagTasksExtension(pi as any);
  return { tools };
}

function createContext() {
  return { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "test" } } as any;
}

describe("two-tool schema rejection", () => {
  const { tools } = createMockPi();
  const taskSchema = tools.get("task").parameters;
  const querySchema = tools.get("task_query").parameters;

  test("task accepts each valid mutation action", () => {
    for (const action of ["create", "update", "archive", "archive_all", "purge"]) {
      const input = action === "create" ? { action, creates: [{ title: "x" }] }
        : action === "update" ? { action, updates: [{ id: "1" }] }
        : action === "archive" || action === "purge" ? { action, ids: ["1"] }
        : { action };
      expect(Value.Check(taskSchema, input)).toBe(true);
    }
  });

  test("task rejects removed actions (complete/done_archive/list/history/next)", () => {
    for (const action of ["complete", "done_archive", "list", "history", "next"]) {
      expect(Value.Check(taskSchema, { action })).toBe(false);
    }
  });

  test("task update entry requires an id", () => {
    // Entry without id is invalid because the nested TaskUpdateSchema requires id.
    expect(Value.Check(taskSchema, { action: "update", updates: [{ status: "in_progress" }] })).toBe(false);
    expect(Value.Check(taskSchema, { action: "update", updates: [{ id: "1", status: "in_progress" }] })).toBe(true);
  });

  test("task_query requires a valid scope and rejects list/history/next as scopes", () => {
    expect(Value.Check(querySchema, { scope: "ready" })).toBe(true);
    expect(Value.Check(querySchema, { scope: "active" })).toBe(true);
    expect(Value.Check(querySchema, { scope: "history" })).toBe(true);
    expect(Value.Check(querySchema, { scope: "list" })).toBe(false);
    expect(Value.Check(querySchema, { scope: "next" })).toBe(false);
    expect(Value.Check(querySchema, { scope: "history", limit: 5, query: "x", includeCompleted: false, includeContext: true })).toBe(true);
  });

  test("task handler throws when a required batch field is missing", async () => {
    const { tools } = createMockPi();
    const tool = tools.get("task");
    const ctx = createContext();
    // archive_all is the only no-arg action; the others must throw without their array.
    await expect(tool.execute("c", { action: "create" }, new AbortController().signal, () => {}, ctx)).rejects.toThrow(/creates is required/);
    await expect(tool.execute("c", { action: "update" }, new AbortController().signal, () => {}, ctx)).rejects.toThrow(/updates is required/);
    await expect(tool.execute("c", { action: "archive" }, new AbortController().signal, () => {}, ctx)).rejects.toThrow(/ids is required/);
    await expect(tool.execute("c", { action: "purge" }, new AbortController().signal, () => {}, ctx)).rejects.toThrow(/ids is required/);
  });

  test("task schema rejects stray singular fields and a top-level id (additionalProperties: false)", () => {
    // A stray singular `create`/`update` field or a top-level `id` must be rejected at the
    // schema level, not silently ignored, per the batch-only contract.
    expect(Value.Check(taskSchema, { action: "create", create: { title: "x" } })).toBe(false);
    expect(Value.Check(taskSchema, { action: "update", update: { id: "1", status: "in_progress" } })).toBe(false);
    expect(Value.Check(taskSchema, { action: "archive", ids: ["1"], id: "1" })).toBe(false);
    // A valid batch call with no stray fields still passes.
    expect(Value.Check(taskSchema, { action: "create", creates: [{ title: "x" }] })).toBe(true);
  });
});