import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMINDER_REMOVE_EVENT,
  REMINDER_UPSERT_EVENT,
} from "pi-reminders/src/types.js";
import dagTasksExtension from "../src/index.ts";

interface EmittedEvent {
  name: string;
  payload: any;
}

async function withDebugLog<T>(fn: (path: string) => Promise<T> | T): Promise<T> {
  const previous = process.env.PI_DAG_TASKS_DEBUG_LOG;
  const dir = mkdtempSync(join(tmpdir(), "pi-dag-tasks-debug-"));
  const path = join(dir, "dag-tasks.jsonl");
  process.env.PI_DAG_TASKS_DEBUG_LOG = path;
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
    .map((line) => JSON.parse(line));
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
  process.env.PI_DAG_TASKS = "off";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_DAG_TASKS;
    else process.env.PI_DAG_TASKS = previous;
  }
}

async function createTask(tools: Map<string, any>, ctx: any, title = "Ship reminders") {
  const tool = tools.get("task_manage");
  expect(tool).toBeTruthy();
  await tool.execute(
    "tool-call-1",
    { action: "create", create: { title, status: "in_progress" } },
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
      await createTask(tools, ctx);

      const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
      const result = handlers.get("context")?.({ messages }, ctx);

      expect(result).toBeUndefined();
      expect(JSON.stringify(messages)).not.toContain("task-reminder");

      const upserts = reminderEvents(emitted, REMINDER_UPSERT_EVENT);
      expect(upserts).toHaveLength(1);
      expect(upserts[0].payload).toMatchObject({
        source: "pi-dag-tasks",
        id: "state",
        label: "Tasks",
        priority: 20,
        ttl: "persistent",
      });
      expect(upserts[0].payload.text).toContain("Task state:");
      expect(upserts[0].payload.text).toContain("Active: #1 Ship reminders");
      expect(upserts[0].payload.text).not.toContain("<task-reminder>");
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

  test("task tool results remove the reminder and suppress one context upsert", async () => {
    await withMemoryTasks(async () => {
      const { handlers, tools, emitted } = createMockPi();
      const ctx = createContext();
      await createTask(tools, ctx);

      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(1);
      emitted.length = 0;

      handlers.get("tool_result")?.({ toolName: "task_manage" });
      expect(reminderEvents(emitted, REMINDER_REMOVE_EVENT)).toEqual([
        {
          name: REMINDER_REMOVE_EVENT,
          payload: { source: "pi-dag-tasks", id: "state" },
        },
      ]);
      emitted.length = 0;

      const suppressed = handlers.get("context")?.({ messages: [] }, ctx);
      expect(suppressed).toBeUndefined();
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(0);
      expect(reminderEvents(emitted, REMINDER_REMOVE_EVENT)).toHaveLength(0);

      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(1);
    });
  });

  test("unrelated tool results do not suppress reminder publishing", async () => {
    await withMemoryTasks(async () => {
      const { handlers, tools, emitted } = createMockPi();
      const ctx = createContext();
      await createTask(tools, ctx);

      handlers.get("tool_result")?.({ toolName: "read" });
      expect(reminderEvents(emitted, REMINDER_REMOVE_EVENT)).toHaveLength(0);

      handlers.get("context")?.({ messages: [] }, ctx);
      expect(reminderEvents(emitted, REMINDER_UPSERT_EVENT)).toHaveLength(1);
    });
  });

  test("writes cache-relevant reminder decision debug records", async () => {
    await withMemoryTasks(async () => {
      await withDebugLog(async (debugLogPath) => {
        const { handlers, tools } = createMockPi();
        const ctx = createContext();
        await createTask(tools, ctx);

        handlers.get("context")?.({ messages: [] }, ctx);
        handlers.get("tool_result")?.({ toolName: "task_manage" });
        handlers.get("context")?.({ messages: [] }, ctx);

        const records = readDebugRecords(debugLogPath);
        expect(records.map((record) => record.action)).toEqual([
          "upsert",
          "remove-tool-result",
          "suppress-next-context",
        ]);
        expect(records[0]).toMatchObject({
          event: "task_reminder_decision",
          taskCounts: { total: 1, open: 1, active: 1, ready: 0, blocked: 0, completed: 0 },
        });
        expect(records[0].textChars).toBeGreaterThan(0);
        expect(records[0].textHash).toMatch(/^[a-f0-9]{16}$/);
        expect(records[0].textPreview).toContain("Task state:");
        expect(JSON.stringify(records)).not.toContain("<task-reminder>");
      });
    });
  });
});
