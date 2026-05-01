import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  REMINDER_REMOVE_EVENT,
  REMINDER_UPSERT_EVENT,
} from "pi-reminders/src/types.js";
import type { ReminderIntent, ReminderRemoveRequest } from "pi-reminders/src/types.js";
import { AutoArchiveManager } from "./auto-clear.js";
import { loadConfig, saveConfig } from "./config.js";
import { DagTaskStore, type TaskPatch } from "./store.js";
import type { DagTask, DagTasksConfig, TaskStatus } from "./types.js";
import { DagTaskWidget } from "./ui/widget.js";

const TOOL_NAMES = new Set(["task_manage", "task_next"]);
const TASK_REMINDER_SOURCE = "pi-dag-tasks";
const TASK_REMINDER_ID = "state";
const TASK_REMINDER_PRIORITY = 20;
const DEBUG_LOG_PATH = join(homedir(), ".pi", "log", "dag-tasks.jsonl");
const DEBUG_TEXT_PREVIEW_CHARS = 160;
const AUTO_CLEAR_DELAY_TURNS = 4;
const VERIFICATION_TERMS = [
  "test", "tests", "tested", "testing",
  "verify", "verified", "verification",
  "check", "checked", "sanity check",
  "review", "reviewed",
  "lint", "linted",
  "typecheck", "type check", "tsc",
  "build", "built",
  "compile", "compiled",
  "validate", "validated",
  "smoke test",
  "manual test",
  "qa",
];

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

const TaskCreateSchema = Type.Object({
  title: Type.String(),
  description: Type.Optional(Type.String()),
  context: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
  activeForm: Type.Optional(Type.String()),
  blockedBy: Type.Optional(Type.Array(Type.String())),
  blocks: Type.Optional(Type.Array(Type.String())),
  owner: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
});

const TaskUpdateSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  context: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
  activeForm: Type.Optional(Type.String()),
  owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
  addBlocks: Type.Optional(Type.Array(Type.String())),
  addBlockedBy: Type.Optional(Type.Array(Type.String())),
  removeBlocks: Type.Optional(Type.Array(Type.String())),
  removeBlockedBy: Type.Optional(Type.Array(Type.String())),
});

const TaskManageParams = Type.Object({
  action: StringEnum(["create", "update", "complete", "archive", "purge", "list", "history"] as const),
  create: Type.Optional(TaskCreateSchema),
  creates: Type.Optional(Type.Array(TaskCreateSchema)),
  update: Type.Optional(TaskUpdateSchema),
  updates: Type.Optional(Type.Array(TaskUpdateSchema)),
  id: Type.Optional(Type.String()),
  ids: Type.Optional(Type.Array(Type.String())),
  archive: Type.Optional(StringEnum(["completed"] as const)),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  query: Type.Optional(Type.String()),
  includeCompleted: Type.Optional(Type.Boolean({ default: true })),
  includeContext: Type.Optional(Type.Boolean({ default: false })),
});

const TaskNextParams = Type.Object({
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
  includeBlocked: Type.Optional(Type.Boolean({ default: true })),
  includeCompleted: Type.Optional(Type.Boolean({ default: true })),
});

type TaskManageParamsType = {
  action: "create" | "update" | "complete" | "archive" | "purge" | "list" | "history";
  create?: Omit<Parameters<DagTaskStore["create"]>[0], never>;
  creates?: Array<Omit<Parameters<DagTaskStore["create"]>[0], never>>;
  update?: TaskPatch;
  updates?: TaskPatch[];
  id?: string;
  ids?: string[];
  archive?: "completed";
  limit?: number;
  query?: string;
  includeCompleted?: boolean;
  includeContext?: boolean;
};

function statusIcon(status: TaskStatus): string {
  if (status === "completed") return "✔";
  if (status === "in_progress") return "◼";
  return "◻";
}

function truncateText(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeVerificationText(text: string): string {
  return text.toLowerCase().replace(/[_-]+/g, " ");
}

function taskSearchText(task: DagTask): string {
  return [
    task.title,
    task.description,
    task.context,
    task.activeForm,
    JSON.stringify(task.metadata ?? {}),
  ].filter(Boolean).join("\n");
}

function hasVerificationSignal(task: DagTask): boolean {
  if (task.metadata?.kind === "verification") return true;
  const text = normalizeVerificationText(taskSearchText(task));
  return VERIFICATION_TERMS.some((term) => text.includes(term));
}

function shouldNudgeVerification(tasks: DagTask[]): boolean {
  if (tasks.length < 3) return false;
  if (!tasks.every((task) => task.status === "completed")) return false;
  return !tasks.some(hasVerificationSignal);
}

function summarizeTasks(store: DagTaskStore, tasks = store.list(), includeCompleted = true, includeContext = false): string {
  const visible = includeCompleted ? tasks : tasks.filter((task) => task.status !== "completed");
  if (visible.length === 0) return "No tasks";
  return visible.map((task) => {
    const blockers = store.openBlockers(task);
    const blocked = blockers.length ? ` [blocked by ${blockers.map((id) => `#${id}`).join(", ")}]` : "";
    const context = includeContext && task.context ? `\n  Context: ${truncateText(task.context)}` : "";
    return `${statusIcon(task.status)} #${task.id} [${task.status}] ${task.title}${blocked}${context}`;
  }).join("\n");
}

function formatArchivedAt(archivedAt: number): string {
  return new Date(archivedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function archiveReasonLabel(reason: ReturnType<DagTaskStore["history"]>[number]["archiveReason"]): string {
  return reason === "completed" ? "completed sweep" : "manual archive";
}

function summarizeHistory(records: ReturnType<DagTaskStore["history"]>, includeContext = false): string {
  if (records.length === 0) return "No archived tasks";
  return ["Archived tasks (newest first):", ...records.map((record) => {
    const task = record.task;
    const context = includeContext && task.context ? `\n  Context: ${truncateText(task.context)}` : "";
    return `◌ #${task.id} ${task.title} — archived ${formatArchivedAt(record.archivedAt)} (${archiveReasonLabel(record.archiveReason)})${context}`;
  })].join("\n");
}

function buildReminder(store: DagTaskStore): string | undefined {
  const tasks = store.list();
  if (tasks.length === 0) return undefined;
  const active = tasks.filter((task) => task.status === "in_progress");
  const ready = store.ready();
  const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0).length;
  const completed = tasks.filter((task) => task.status === "completed").length;
  const open = tasks.length - completed;
  if (open === 0) {
    const parts = ["All tasks are completed. Before finalizing, verify if appropriate or state why verification was not run. Archive completed tasks after the user has seen the result or when they are no longer useful for review."];
    if (shouldNudgeVerification(tasks)) parts.push("All tasks are completed, but no verification task is recorded. Before finalizing, verify the work if practical, or state why verification was not run.");
    return parts.join("\n");
  }
  const parts = [
    `Task state: ${open} open, ${active.length} active, ${ready.length} ready, ${blocked} blocked${completed ? `, ${completed} completed` : ""}.`,
  ];
  if (active[0]) {
    parts.push(`Active: #${active[0].id} ${active[0].title}`);
  }
  if (ready.length > 0) parts.push(`Ready next: ${ready.slice(0, 3).map((task) => `#${task.id} ${task.title}`).join("; ")}`);
  parts.push("Keep task statuses current; use task_next for ready work.");
  return parts.join("\n");
}

function taskCounts(store: DagTaskStore): Record<string, number> {
  const tasks = store.list();
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.filter((task) => task.status === "in_progress").length;
  const ready = store.ready().length;
  const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0).length;
  return {
    total: tasks.length,
    open: tasks.length - completed,
    active,
    ready,
    blocked,
    completed,
  };
}

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function textPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > DEBUG_TEXT_PREVIEW_CHARS
    ? `${collapsed.slice(0, DEBUG_TEXT_PREVIEW_CHARS - 1)}…`
    : collapsed;
}

function logReminderDecision(
  action: string,
  store: DagTaskStore,
  text?: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    const record: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      event: "task_reminder_decision",
      action,
      taskCounts: taskCounts(store),
      ...extra,
    };
    if (text !== undefined) {
      record.textChars = text.length;
      record.textHash = textHash(text);
      record.textPreview = textPreview(text);
    }

    const path = process.env.PI_DAG_TASKS_DEBUG_LOG || DEBUG_LOG_PATH;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  } catch {
    // Debug logging is best-effort and must not affect task handling.
  }
}

function taskReminderIntent(text: string): ReminderIntent {
  return {
    source: TASK_REMINDER_SOURCE,
    id: TASK_REMINDER_ID,
    label: "Tasks",
    priority: TASK_REMINDER_PRIORITY,
    ttl: "persistent",
    text,
  };
}

function taskReminderRemoveRequest(): ReminderRemoveRequest {
  return {
    source: TASK_REMINDER_SOURCE,
    id: TASK_REMINDER_ID,
  };
}

export default function dagTasksExtension(pi: ExtensionAPI): void {
  const cfg: DagTasksConfig = {};
  let store = new DagTaskStore();
  const widget = new DagTaskWidget(store);
  const autoArchive = new AutoArchiveManager(() => store, () => cfg.autoArchiveCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY_TURNS);
  let currentTurn = 0;
  let storeReady = false;
  let suppressNextReminder = false;

  function resolveCwd(ctx?: ExtensionContext): string {
    return ctx?.cwd ?? process.env.PWD ?? process.cwd();
  }

  function refreshConfig(cwd: string): void {
    delete cfg.taskScope;
    delete cfg.autoArchiveCompleted;
    Object.assign(cfg, loadConfig(cwd));
  }

  function resolveStorePath(ctx?: ExtensionContext): string | undefined {
    const cwd = resolveCwd(ctx);
    const env = process.env.PI_DAG_TASKS;
    if (env === "off") return undefined;
    if (env?.startsWith("/")) return env;
    if (env?.startsWith(".")) return resolve(cwd, env);
    if (env) return join(process.env.HOME ?? cwd, ".pi", "dag-tasks", `${env}.json`);
    const scope = cfg.taskScope ?? "session";
    if (scope === "memory") return undefined;
    if (scope === "project") return join(cwd, ".pi", "dag-tasks", "tasks.json");
    const sessionId = ctx?.sessionManager.getSessionId?.() ?? "session";
    return join(cwd, ".pi", "dag-tasks", `tasks-${sessionId}.json`);
  }

  function ensureStore(ctx: ExtensionContext): void {
    if (storeReady) return;
    refreshConfig(resolveCwd(ctx));
    store.setFilePath(resolveStorePath(ctx));
    storeReady = true;
    widget.setStore(store);
  }

  function refreshUi(ctx?: ExtensionContext): void {
    if (ctx?.hasUI) widget.setUi(ctx.ui as any);
    widget.update();
  }

  pi.on("session_start", (_event, ctx) => {
    storeReady = false;
    ensureStore(ctx);
    refreshUi(ctx);
  });

  pi.on("session_shutdown", () => widget.dispose());

  pi.on("context", (_event, ctx) => {
    ensureStore(ctx);
    refreshUi(ctx);
    if (suppressNextReminder) {
      suppressNextReminder = false;
      logReminderDecision("suppress-next-context", store);
      return undefined;
    }
    const reminder = buildReminder(store);
    if (!reminder) {
      pi.events.emit(REMINDER_REMOVE_EVENT, taskReminderRemoveRequest());
      logReminderDecision("remove-empty", store);
      return undefined;
    }
    pi.events.emit(REMINDER_UPSERT_EVENT, taskReminderIntent(reminder));
    logReminderDecision("upsert", store, reminder);
    return undefined;
  });

  pi.on("turn_start", (_event, ctx) => {
    currentTurn++;
    ensureStore(ctx);
    if (autoArchive.onTurnStart(currentTurn)) store.deleteFileIfEmpty();
    refreshUi(ctx);
  });

  pi.on("tool_result", (event) => {
    if (TOOL_NAMES.has(event.toolName)) {
      suppressNextReminder = true;
      pi.events.emit(REMINDER_REMOVE_EVENT, taskReminderRemoveRequest());
      logReminderDecision("remove-tool-result", store, undefined, { toolName: event.toolName });
    }
    return {};
  });

  pi.registerTool({
    name: "task_manage",
    label: "Task Manage",
    description: "Manage Pi's task list: the durable todo/progress tracker for multi-step work. Use action:'create' for single or batch creation via create/creates; dependencies use task IDs like '1', not titles. Use context for durable intent and status:'in_progress' when starting immediately.",
    promptSnippet: "Manage task list",
    promptGuidelines: [
      "This is Pi's single task/todo tracker. Use task_manage instead of writing separate informal todo lists in prose when tracking is appropriate.",
      "Use proactively for 3+ distinct steps, non-trivial multi-action work, dependencies, ambiguity, checkpoints, multiple user requests, discovered follow-up work, or durable intent across turns/compression.",
      "Skip task_manage for straightforward work, roughly the easiest 25%, single-step work, pure answers, or work under 3 trivial steps.",
      "Size the task list to the actual work; there is no maximum task count. Long or complex processes may warrant 20+ tasks when that preserves clarity, dependencies, or checkpoints.",
      "Start with the smallest useful task list and expand it when exploration reveals real subwork, dependencies, or blockers; do not compress genuinely distinct work into an artificial 6-8 task range.",
      "Use action:'create' for both create and creates; there is no action:'creates'.",
      "Dependency fields blockedBy/blocks/addBlockedBy/addBlocks must contain task IDs like '1', not task titles; create first, then update dependencies if you need generated IDs.",
      "Use dependencies only when they change what can start next; blocked work is represented with blockedBy/blocks dependencies, not a separate blocked status.",
      "Normally keep one task in_progress per active worker. Multiple in_progress tasks are valid only for genuine parallel work or distinct owners/subagents.",
      "When creating a task map, add context to pending tasks up front: constraints, relevant findings, expected inputs, dependencies, and definition of done; update context as decisions/outcomes emerge.",
      "Keep tasks outcome-oriented and verifiable, not microscopic. For tests, builds, lint, typecheck, manual review, or output inspection tasks, set metadata.kind = 'verification'.",
      "Do not create standalone tasks for tiny process/meta instructions like compress context, reply concisely, run final check, or summarize changes unless they are a real multi-step workflow phase; include them in the relevant task context/definition of done instead.",
      "Use task_next for ready/unblocked work; don't start blocked tasks.",
    ],
    parameters: TaskManageParams,
    async execute(_toolCallId, params: TaskManageParamsType, _signal, _onUpdate, ctx) {
      ensureStore(ctx);
      const lines: string[] = [];
      const details: Record<string, unknown> = { action: params.action };

      if (params.action === "create") {
        const inputs = [...(params.creates ?? []), ...(params.create ? [params.create] : [])];
        if (inputs.length === 0) throw new Error("create or creates is required");
        for (const input of inputs) {
          const { task, warnings } = store.create(input);
          if (task.status === "in_progress") widget.markActive(task.id, true);
          if (task.status === "completed") autoArchive.trackCompletion(task.id, currentTurn);
          lines.push(`Created #${task.id}: ${task.title}${task.status !== "pending" ? ` [${task.status}]` : ""}${warnings.length ? ` (warning: ${warnings.join("; ")})` : ""}`);
        }
        autoArchive.resetBatchCountdown();
      } else if (params.action === "update") {
        const updates = [...(params.updates ?? []), ...(params.update ? [params.update] : [])];
        if (updates.length === 0) throw new Error("update or updates is required");
        for (const patch of updates) {
          const before = store.get(patch.id);
          const result = store.update(patch);
          if (patch.status === "in_progress") widget.markActive(patch.id, true);
          if (patch.status === "completed") {
            widget.markActive(patch.id, false);
            autoArchive.trackCompletion(patch.id, currentTurn);
          }
          if (patch.status === "pending") widget.markActive(patch.id, false);
          if (before?.status === "completed" && patch.status !== "completed") autoArchive.resetBatchCountdown();
          lines.push(result.task ? `Updated #${patch.id}: ${result.changed.join(", ") || "no fields"}${result.warnings.length ? ` (warning: ${result.warnings.join("; ")})` : ""}` : `Skipped #${patch.id}: ${result.warnings.join("; ")}`);
        }
      } else if (params.action === "complete") {
        const ids = params.ids ?? (params.id ? [params.id] : []);
        if (ids.length === 0) throw new Error("id or ids is required");
        for (const id of ids) {
          const result = store.update({ id, status: "completed" });
          widget.markActive(id, false);
          if (result.task) autoArchive.trackCompletion(id, currentTurn);
          lines.push(result.task ? `Completed #${id}` : `Skipped #${id}: not found`);
        }
      } else if (params.action === "archive") {
        const ids = params.ids ?? (params.id ? [params.id] : []);
        const count = ids.length > 0 ? store.archive(ids) : store.archiveCompleted();
        for (const id of ids) widget.markActive(id, false);
        lines.push(`Archived ${count} task(s)`);
      } else if (params.action === "purge") {
        const ids = params.ids ?? (params.id ? [params.id] : []);
        if (ids.length === 0) throw new Error("id or ids is required");
        const count = store.purge(ids);
        for (const id of ids) widget.markActive(id, false);
        lines.push(`Purged ${count}/${ids.length} task(s)`);
      } else if (params.action === "list") {
        lines.push(summarizeTasks(store, store.list(), params.includeCompleted ?? true, params.includeContext ?? false));
      } else if (params.action === "history") {
        const history = store.history(params.limit ?? 20, params.query);
        lines.push(summarizeHistory(history, params.includeContext ?? false));
        details.history = history;
      }

      store.deleteFileIfEmpty();
      refreshUi(ctx);
      details.tasks = store.list();
      return textResult(lines.join("\n"), details);
    },
  });

  pi.registerTool({
    name: "task_next",
    label: "Task Next",
    description: "Return ready/unblocked tasks from Pi's task list and a compact summary.",
    promptSnippet: "Next ready tasks",
    promptGuidelines: ["Use after completing work or when resuming; don't start blocked tasks."],
    parameters: TaskNextParams,
    async execute(_toolCallId, params: { limit?: number; includeBlocked?: boolean; includeCompleted?: boolean }, _signal, _onUpdate, ctx) {
      ensureStore(ctx);
      const limit = params.limit ?? 5;
      const tasks = store.list();
      const ready = store.ready().slice(0, limit);
      const active = tasks.filter((task) => task.status === "in_progress");
      const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0);
      const completed = tasks.filter((task) => task.status === "completed");
      const lines = [`Summary: ${tasks.length} total, ${ready.length} ready, ${active.length} active, ${blocked.length} blocked, ${completed.length} completed.`];
      if (active.length) lines.push(`Active:\n${summarizeTasks(store, active, true, true)}`);
      lines.push(ready.length ? `Ready:\n${summarizeTasks(store, ready, true, true)}` : "Ready: none");
      if (params.includeBlocked ?? true) lines.push(blocked.length ? `Blocked:\n${summarizeTasks(store, blocked, true)}` : "Blocked: none");
      return textResult(lines.join("\n\n"), { ready, active, blocked, completedCount: completed.length });
    },
  });

  pi.registerCommand("tasks", {
    description: "Manage DAG tasks — view, create, archive, settings",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ensureStore(ctx);
      refreshUi(ctx);

      const main = async (): Promise<void> => {
        const tasks = store.list();
        const done = tasks.filter((task) => task.status === "completed").length;
        const choice = await ctx.ui.select("DAG Tasks", [
          `View tasks (${tasks.length})`,
          "Create task",
          ...(done ? [`Archive completed (${done})`] : []),
          "View archived tasks",
          "Settings",
        ]);
        if (!choice) return;
        if (choice.startsWith("View tasks")) return viewTasks();
        if (choice === "Create task") return createTask();
        if (choice.startsWith("Archive completed")) { store.archiveCompleted(); refreshUi(ctx); return main(); }
        if (choice === "View archived tasks") return viewHistory();
        if (choice === "Settings") return settings();
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          const emptyChoice = await ctx.ui.select("No active tasks", ["View archived tasks", "← Back"]);
          return emptyChoice === "View archived tasks" ? viewHistory() : main();
        }
        const selected = await ctx.ui.select("Active tasks", [...tasks.map((task) => `${statusIcon(task.status)} #${task.id} [${task.status}] ${task.title}`), "← Back"]);
        if (!selected || selected === "← Back") return main();
        const id = selected.match(/#(\d+)/)?.[1];
        if (id) return taskDetail(id);
      };

      const viewHistory = async (): Promise<void> => {
        const history = store.history(50);
        if (history.length === 0) { await ctx.ui.select("No archived tasks", ["← Back"]); return main(); }
        const selected = await ctx.ui.select("Archived tasks — newest first", [...history.map((record) => `◌ #${record.task.id} ${record.task.title} — ${formatArchivedAt(record.archivedAt)} · ${archiveReasonLabel(record.archiveReason)}`), "← Back"]);
        if (!selected || selected === "← Back") return main();
        const id = selected.match(/#(\d+)/)?.[1];
        const record = history.find((item) => item.task.id === id);
        if (record) await ctx.ui.select(`#${record.task.id} ${record.task.title}\nArchived: ${formatArchivedAt(record.archivedAt)} (${archiveReasonLabel(record.archiveReason)})\n${record.task.description}${record.task.context ? `\n\nContext: ${record.task.context}` : ""}`, ["← Back"]);
        return viewHistory();
      };

      const taskDetail = async (id: string): Promise<void> => {
        const task = store.get(id);
        if (!task) return viewTasks();
        const blockers = store.openBlockers(task);
        const action = await ctx.ui.select(`#${task.id} [${task.status}] ${task.title}\n${task.description}${task.context ? `\n\nContext: ${task.context}` : ""}${blockers.length ? `\nBlocked by: ${blockers.map((x) => `#${x}`).join(", ")}` : ""}`, [
          ...(task.status === "pending" ? ["Start"] : []),
          ...(task.status !== "completed" ? ["Complete"] : []),
          "Archive",
          "← Back",
        ]);
        if (action === "Start") { store.update({ id, status: "in_progress" }); widget.markActive(id, true); }
        if (action === "Complete") { store.update({ id, status: "completed" }); widget.markActive(id, false); autoArchive.trackCompletion(id, currentTurn); }
        if (action === "Archive") { store.archive([id]); widget.markActive(id, false); }
        refreshUi(ctx);
        return viewTasks();
      };

      const createTask = async (): Promise<void> => {
        const title = await ctx.ui.input("Task title");
        if (!title) return main();
        const description = await ctx.ui.input("Task description");
        const context = await ctx.ui.input("Task context / intent (optional)");
        store.create({ title, description: description ?? "", context: context || undefined });
        refreshUi(ctx);
        return main();
      };

      const settings = async (): Promise<void> => {
        const scope = await ctx.ui.select("Task storage", ["memory", "session", "project", "← Back"]);
        if (scope && scope !== "← Back") {
          cfg.taskScope = scope as "memory" | "session" | "project";
          saveConfig(cfg, resolveCwd(ctx));
          storeReady = false;
          ensureStore(ctx);
        }
        const autoArchiveChoice = await ctx.ui.select("Auto-archive completed", ["never", "on_list_complete", "on_task_complete", "← Back"]);
        if (autoArchiveChoice && autoArchiveChoice !== "← Back") {
          cfg.autoArchiveCompleted = autoArchiveChoice as "never" | "on_list_complete" | "on_task_complete";
          saveConfig(cfg, resolveCwd(ctx));
        }
        refreshUi(ctx);
        return main();
      };

      await main();
    },
  });
}
