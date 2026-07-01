import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMINDER_REMOVE_EVENT,
  REMINDER_UPSERT_EVENT,
} from "pi-extension-utils";
import dagTasksExtension from "../src/index.ts";

interface EmittedEvent {
  name: string;
  payload: any;
}

async function withDebugLog<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_DAG_TASKS_DEBUG_LOG;
  const dir = mkdtempSync(join(tmpdir(), "pi-dag-tasks-debug-"));
  const path = join(dir, "pi-dag-tasks.jsonl");
  process.env.PI_DAG_TASKS_DEBUG_LOG = dir;
  try {
    return await fn(path);
  } finally {
    if (previous === undefined) delete process.env.PI_DAG_TASKS_DEBUG_LOG;
    else process.env.PI_DAG_TASKS_DEBUG_LOG = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function readDebugRecords(path: string): any[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const start = line.indexOf("{");
      if (start === -1) return [];
      try {
        return [JSON.parse(line.slice(start))];
      } catch {
        return [];
      }
    });
}

function createMockPi() {
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const emitted: EmittedEvent[] = [];

  const pi = {
    events: {
      emit(name: string, payload: any) {
        emitted.push({ name, payload });
      },
      on() {},
    },
    on(name: string, handler: Function) {
      handlers.set(name, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
  };

  dagTasksExtension(pi as any);

  return { handlers, tools, emitted };
}

function createContext() {
  return {
    cwd: process.cwd(),
    hasUI: false,
    sessionManager: {
      getSessionId: () => "test-session",
    },
  } as any;
}

async function withMemoryTasks<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_DAG_TASKS;
  const previousMs = process.env.PI_DAG_TASKS_REMINDER_FORGOTTEN_MS;
  process.env.PI_DAG_TASKS = "off";
  process.env.PI_DAG_TASKS_REMINDER_FORGOTTEN_MS = "0";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_DAG_TASKS;
    else process.env.PI_DAG_TASKS = previous;
    if (previousMs === undefined) delete process.env.PI_DAG_TASKS_REMINDER_FORGOTTEN_MS;
    else process.env.PI_DAG_TASKS_REMINDER_FORGOTTEN_MS = previousMs;
  }
}

function advanceTurns(handlers: Map<string, Function>, ctx: any, turns: number): void {
  for (let i = 0; i < turns; i++) handlers.get("turn_start")?.({}, ctx);
}

async function createTask(tools: Map<string, any>, ctx: any, title = "Ship reminders", context?: string) {
  const tool = tools.get("task");
  expect(tool).toBeTruthy();
  await tool.execute(
    "tool-call-1",
    { action: "create", creates: [{ title, status: "in_progress", context }] },
    new AbortController().signal,
    () => {},
    ctx,
  );
}

function reminderEvents(emitted: EmittedEvent[], name: string): EmittedEvent[] {
  return emitted.filter((event) => event.name === name);
}

describe("task reminder publishing", () => {
  test("publishes compact persistent reminder intent instead of mutating context messages", async () => {
    await withMemoryTasks(async () => {
      const { handlers, tools, emitted } = createMockPi();
      const ctx = createContext();
      await createTask(tools, ctx, "Ship reminders", "Very long in_progress context should not be emitted into the volatile reminder trailer.");

      advanceTurns(handlers, ctx, 15);
      const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
      const result = handlers.get("context")?.({ messages }, ctx);

      expect(result).toBeUndefined();
      expect(JSON.stringify(messages)).not.toContain("task-reminder");

      const upserts = reminderEvents(emitted, REMINDER_UPSERT_EVENT);
      expect(upserts.length).toBeGreaterThanOrEqual(1);
      const latest = upserts.at(-1)!;
      expect(latest.payload).toMatchObject({
        source: "pi-dag-tasks",
        id: "state",
        label: "Tasks",
        priority: 20,
        ttl: "once",
        display: false,
      });
      expect(latest.payload.text).toContain("Task checkpoint: 15 turns since task tools.");
      expect(latest.payload.text).toContain("Continue or complete in_progress #1 Ship reminders");
      expect(latest.payload.text).toMatch(/#1 Ship reminders \(~\d+m\)/);
      expect(latest.payload.text).not.toContain("In progress context:");
      expect(latest.payload.text).not.toContain("Very long in_progress context");
      expect(latest.payload.text).not.toContain("<task-reminder>");
    });
  });

  test("removes reminder when there are no tasks", async () => {
    await withMemoryTasks(() => {
      const { handlers, emitted } = createMockPi();
      const ctx = createContext();

      const result = handlers.get("context")?.({ messages: [] }, ctx);

      expect(result).toBeUndefined();
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(0);
      expect(reminderEvents(emitted, REMINDER_REMOVE_EVENT)).toEqual([
        {
          name: REMINDER_REMOVE_EVENT,
          payload: { source: "pi-dag-tasks", id: "state" },
        },
      ]);
    });
  });

  test("unchanged task reminders are not re-upserted before repeat interval", async () => {
    await withMemoryTasks(async () => {
      const { handlers, tools, emitted } = createMockPi();
      const ctx = createContext();
      await createTask(tools, ctx);

      advanceTurns(handlers, ctx, 15);
      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(1);
      emitted.length = 0;

      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(0);

      advanceTurns(handlers, ctx, 15);
      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(1);
    });
  });

  test("task tool calls remove cached reminders and suppress five turns", async () => {
    await withMemoryTasks(async () => {
      const { handlers, tools, emitted } = createMockPi();
      const ctx = createContext();
      await createTask(tools, ctx);

      advanceTurns(handlers, ctx, 15);
      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT).length).toBeGreaterThanOrEqual(1);
      emitted.length = 0;

      handlers.get("tool_call")?.({ toolName: "task" }, ctx);
      expect(reminderEvents(emitted, REMINDER_REMOVE_EVENT)).toEqual([
        {
          name: REMINDER_REMOVE_EVENT,
          payload: { source: "pi-dag-tasks", id: "state" },
        },
      ]);
      emitted.length = 0;

      for (let i = 0; i < 5; i++) {
        const suppressed = handlers.get("context")?.({ messages: [] }, ctx);
        expect(suppressed).toBeUndefined();
        expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(0);
        handlers.get("turn_start")?.({}, ctx);
      }

      advanceTurns(handlers, ctx, 10);
      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT).length).toBeGreaterThanOrEqual(1);
    });
  });

  test("complete via update then archive_all clears the list in one sweep", async () => {
    await withMemoryTasks(async () => {
      const { tools, handlers } = createMockPi();
      const ctx = createContext();
      const tool = tools.get("task");
      const query = tools.get("task_query");

      const created = await tool.execute("tool-call-1", { action: "create", creates: [{ title: "Ship it", status: "in_progress" }] }, new AbortController().signal, () => {}, ctx);
      expect(created.content[0].text).toContain("1 in_progress. Next: continue in_progress #1 Ship it.");
      const id = created.details.operations[0].id;
      const completed = await tool.execute("tool-call-2", { action: "update", updates: [{ id, status: "completed" }] }, new AbortController().signal, () => {}, ctx);
      expect(completed.content[0].text).toContain("Next: verify if appropriate; archive completed tasks when ready.");
      const archived = await tool.execute("tool-call-3", { action: "archive_all" }, new AbortController().signal, () => {}, ctx);
      expect(archived.content[0].text).toContain("Next: no tasks remain.");
      const list = await query.execute("tool-call-4", { scope: "current" }, new AbortController().signal, () => {}, ctx);
      expect(list.content[0].text).toBe("No tasks");
      expect(handlers).toBeDefined();
    });
  });

  test("task mutations do not immediately announce reminders during tool chains", async () => {
    await withMemoryTasks(async () => {
      const { tools, emitted } = createMockPi();
      const ctx = createContext();
      const tool = tools.get("task");

      await tool.execute("tool-call-1", { action: "create", creates: [{ title: "Done", status: "completed" }] }, new AbortController().signal, () => {}, ctx);
      await tool.execute("tool-call-2", { action: "create", creates: [{ title: "New in_progress", status: "in_progress" }] }, new AbortController().signal, () => {}, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(0);
    });
  });

  test("unrelated tool results do not suppress reminder publishing", async () => {
    await withMemoryTasks(async () => {
      const { handlers, tools, emitted } = createMockPi();
      const ctx = createContext();
      await createTask(tools, ctx);

      handlers.get("tool_result")?.({ toolName: "read" }, ctx);
      expect(reminderEvents(emitted, REMINDER_REMOVE_EVENT)).toHaveLength(0);

      advanceTurns(handlers, ctx, 15);
      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT).length).toBeGreaterThanOrEqual(1);
    });
  });

  test("writes cache-relevant reminder decision debug records", async () => {
    await withMemoryTasks(async () => {
      await withDebugLog(async (debugLogPath) => {
        const { handlers, tools } = createMockPi();
        const ctx = createContext();
        await createTask(tools, ctx);

        advanceTurns(handlers, ctx, 15);
        handlers.get("context")?.({ messages: [] }, ctx);
        handlers.get("tool_call")?.({ toolName: "task" }, ctx);
        handlers.get("tool_result")?.({ toolName: "task" }, ctx);
        handlers.get("context")?.({ messages: [] }, ctx);

        const records = readDebugRecords(debugLogPath).filter((r) => r.event === "task_reminder_decision");
        expect(records.map((record) => record.action)).toEqual([
          "upsert",
          "suppress-before-tool-call",
          "suppress-after-tool-result",
          "suppress-cooldown",
        ]);
        expect(records[0]).toMatchObject({
          event: "task_reminder_decision",
          taskCounts: { total: 1, open: 1, in_progress: 1, ready: 0, blocked: 0, completed: 0 },
        });
        expect(records[0].textChars).toBeGreaterThan(0);
        expect(records[0].textHash).toMatch(/^[a-f0-9]{16}$/);
        expect(records[0].textPreview).toContain("Task checkpoint:");
        expect(records[1]).toMatchObject({ currentTurn: 15, suppressUntilTurn: 20 });
        expect(JSON.stringify(records)).not.toContain("<task-reminder>");
      });
    });
  });
});
