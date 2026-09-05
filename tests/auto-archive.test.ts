import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dagTasksExtension from "../src/index.ts";

async function withSession(run: (session: {
  mutate: (params: any) => Promise<any>;
  query: (scope: string) => Promise<any>;
  advance: (turns: number) => void;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "pi-dag-tasks-auto-archive-"));
  const previousLog = process.env.PI_DAG_TASKS_DEBUG_LOG;
  process.env.PI_DAG_TASKS_DEBUG_LOG = root;
  const handlers = new Map<string, Function>();
  const tools = new Map<string, any>();
  const ctx = {
    cwd: root,
    hasUI: false,
    sessionManager: { getSessionId: () => "archive-test" },
  } as any;
  try {
    dagTasksExtension({
      events: { emit() {}, on() { return () => {}; } },
      on(name: string, handler: Function) { handlers.set(name, handler); },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
    } as any);
    handlers.get("session_start")!({}, ctx);
    const execute = (name: string, params: any) => tools.get(name).execute(
      "test", params, new AbortController().signal, () => {}, ctx,
    );
    await run({
      mutate: (params) => execute("task", params),
      query: async (scope) => (await execute("task_query", { scope })).details,
      advance(turns) {
        for (let i = 0; i < turns; i++) handlers.get("turn_start")!({}, ctx);
      },
    });
  } finally {
    handlers.get("session_shutdown")?.({}, ctx);
    if (previousLog === undefined) delete process.env.PI_DAG_TASKS_DEBUG_LOG;
    else process.env.PI_DAG_TASKS_DEBUG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
}

test("completed-on-create starts the four-turn list archive countdown", async () => {
  await withSession(async ({ mutate, query, advance }) => {
    await mutate({ action: "create", creates: [
      { title: "Done A", status: "completed" },
      { title: "Done B", status: "completed" },
    ] });
    advance(3);
    expect((await query("current")).tasks).toHaveLength(2);
    expect((await query("history")).history).toHaveLength(0);
    advance(1);
    expect((await query("current")).tasks).toHaveLength(0);
    expect((await query("history")).history.map((entry: any) => entry.task.title)).toEqual(["Done B", "Done A"]);
  });
});

for (const status of ["pending", "in_progress"] as const) {
  for (const incompleteFirst of [false, true]) {
    test(`mixed create batch stays active (${status}, incomplete first: ${incompleteFirst})`, async () => {
      await withSession(async ({ mutate, query, advance }) => {
        const creates = [{ title: "Done", status: "completed" }, { title: "Open", status }];
        if (incompleteFirst) creates.reverse();
        await mutate({ action: "create", creates });
        advance(6);
        expect((await query("current")).tasks).toHaveLength(2);
        expect((await query("history")).history).toHaveLength(0);
        const open = (await query("current")).tasks.find((task: any) => task.title === "Open");
        await mutate({ action: "update", updates: [{ id: open.id, status: "completed" }] });
        advance(3);
        expect((await query("history")).history).toHaveLength(0);
        advance(1);
        expect((await query("history")).history).toHaveLength(2);
      });
    });
  }

  test(`creating ${status} work cancels a running archive countdown`, async () => {
    await withSession(async ({ mutate, query, advance }) => {
      await mutate({ action: "create", creates: [{ title: "Done", status: "completed" }] });
      advance(3);
      await mutate({ action: "create", creates: [{ title: "Open", status }] });
      advance(6);
      expect((await query("current")).tasks).toHaveLength(2);
      expect((await query("history")).history).toHaveLength(0);
    });
  });

  test(`reopening as ${status} cancels and recompletion restarts the archive countdown`, async () => {
    await withSession(async ({ mutate, query, advance }) => {
      await mutate({ action: "create", creates: [{ title: "Done", status: "completed" }] });
      advance(3);
      await mutate({ action: "update", updates: [{ id: "1", status }] });
      advance(6);
      expect((await query("current")).tasks[0].status).toBe(status);
      expect((await query("history")).history).toHaveLength(0);
      await mutate({ action: "update", updates: [{ id: "1", status: "completed" }] });
      advance(3);
      expect((await query("history")).history).toHaveLength(0);
      advance(1);
      expect((await query("history")).history).toHaveLength(1);
    });
  });
}

test("creating completed work restarts the list countdown for the new batch", async () => {
  await withSession(async ({ mutate, query, advance }) => {
    await mutate({ action: "create", creates: [{ title: "Done A", status: "completed" }] });
    advance(3);
    await mutate({ action: "create", creates: [{ title: "Done B", status: "completed" }] });
    advance(3);
    expect((await query("current")).tasks).toHaveLength(2);
    advance(1);
    expect((await query("history")).history).toHaveLength(2);
  });
});
