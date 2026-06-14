import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  REMINDER_REMOVE_EVENT,
  REMINDER_UPSERT_EVENT,
  type ReminderIntent,
  type ReminderRemoveRequest,
} from "pi-extension-utils";
import { AutoArchiveManager } from "./auto-clear.js";
import { loadConfig, saveConfig } from "./config.js";
import { DagTaskStore, type TaskPatch } from "./store.js";
import type { DagTask, DagTasksConfig, TaskManageResultDetails, TaskNextResultDetails, TaskOperation, TaskStatus } from "./types.js";
import {
  renderTaskManageCall,
  renderTaskManageResult,
  renderTaskNextCall,
  renderTaskNextResult,
} from "./ui/tool-render.js";
import { DagTaskWidget } from "./ui/widget.js";

const TOOL_NAMES = new Set(["task_manage", "task_next"]);
const TASK_REMINDER_SOURCE = "pi-dag-tasks";
const TASK_REMINDER_ID = "state";
const TASK_REMINDER_PRIORITY = 20;
const DEBUG_LOG_PATH = join(homedir(), ".pi", "log", "dag-tasks.jsonl");
const DEBUG_TEXT_PREVIEW_CHARS = 160;
const AUTO_CLEAR_DELAY_TURNS = 4;
const TASK_REMINDER_FORGOTTEN_TURNS = 15;
const DEFAULT_TASK_REMINDER_FORGOTTEN_MS = 60_000;
const TASK_REMINDER_TOOL_COOLDOWN_TURNS = 5;
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

function textResult<TDetails = unknown>(text: string, details?: TDetails) {
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
  action: StringEnum(["create", "update", "complete", "done_archive", "archive", "purge", "list", "history"] as const),
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
  action: "create" | "update" | "complete" | "done_archive" | "archive" | "purge" | "list" | "history";
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

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}

function formatReminderDuration(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `~${hours}h ${rem}m` : `~${hours}h`;
}

function activeTaskLabel(task: DagTask, now = Date.now()): string {
  const elapsed = task.startedAt ? ` (${formatReminderDuration(now - task.startedAt)})` : "";
  return `#${task.id} ${task.title}${elapsed}`;
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

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function taskStatePrefix(active: DagTask[], ready: DagTask[], blocked: DagTask[], completed: number): string {
  return [
    active.length ? countLabel(active.length, "active") : undefined,
    ready.length ? countLabel(ready.length, "ready") : undefined,
    blocked.length ? countLabel(blocked.length, "blocked") : undefined,
    completed ? countLabel(completed, "done") : undefined,
  ].filter(Boolean).join(", ");
}

function buildTaskManageGuidance(store: DagTaskStore): string {
  const tasks = store.list();
  if (tasks.length === 0) return "Next: no tasks remain.";

  const completed = tasks.filter((task) => task.status === "completed").length;
  const open = tasks.length - completed;
  if (open === 0) return `${countLabel(completed, "task")} done. Next: verify if appropriate; archive completed tasks when ready.`;

  const active = tasks.filter((task) => task.status === "in_progress");
  const ready = store.ready();
  const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0);
  const prefix = taskStatePrefix(active, ready, blocked, completed);
  const state = prefix ? `${prefix}. ` : "";

  if (active.length > 0) {
    const primary = active[0];
    const readyText = ready.length ? ` Ready after that: #${ready[0].id}.` : "";
    return `${state}Next: continue active #${primary.id} ${primary.title}.${readyText}`;
  }

  if (ready.length > 0) {
    const primary = ready[0];
    return `${state}Next: start ready #${primary.id} ${primary.title}.`;
  }

  const blockers = [...new Set(blocked.flatMap((task) => store.openBlockers(task)))];
  return blockers.length
    ? `${state}Next: all open tasks are blocked. Resolve blockers: ${blockers.map((id) => `#${id}`).join(", ")}.`
    : `${state}Next: no ready tasks. Review task dependencies.`;
}

function reminderStateKey(store: DagTaskStore): string {
  return JSON.stringify(store.list().map((task) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    activeForm: task.activeForm,
    blockedBy: [...task.blockedBy].sort(),
    blocks: [...task.blocks].sort(),
  })));
}

function buildReminder(store: DagTaskStore, turnsSinceTaskTool: number): string | undefined {
  const tasks = store.list();
  if (tasks.length === 0) return undefined;
  const active = tasks.filter((task) => task.status === "in_progress");
  const ready = store.ready();
  const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const open = tasks.length - completed;
  if (open === 0) {
    const parts = [`Task checkpoint: all tasks are completed after ${turnsSinceTaskTool} turns without task-tool use. Verify if appropriate; archive completed tasks when ready.`];
    if (shouldNudgeVerification(tasks)) parts.push("No verification task is recorded. Verify the work if practical, or state why verification was not run before finalizing.");
    return parts.join("\n");
  }
  if (active[0]) {
    const parts = [`Task checkpoint: ${turnsSinceTaskTool} turns since task tools. Continue or complete active ${activeTaskLabel(active[0])}.`];
    if (ready.length > 0) parts.push(`Ready after that: ${ready.slice(0, 3).map((task) => `#${task.id} ${task.title}`).join("; ")}.`);
    return parts.join("\n");
  }
  if (ready.length > 0) {
    return `Task checkpoint: no task is in progress after ${turnsSinceTaskTool} turns. Start ready #${ready[0].id} ${ready[0].title}.`;
  }
  if (blocked.length > 0) {
    const blockers = [...new Set(blocked.flatMap((task) => store.openBlockers(task)))];
    return `Task checkpoint: all open tasks are blocked after ${turnsSinceTaskTool} turns. Resolve blockers: ${blockers.map((id) => `#${id}`).join(", ")}.`;
  }
  return undefined;
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

function taskReminderForgottenMs(): number {
  const raw = process.env.PI_DAG_TASKS_REMINDER_FORGOTTEN_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TASK_REMINDER_FORGOTTEN_MS;
}

function taskReminderIntent(text: string): ReminderIntent {
  return {
    source: TASK_REMINDER_SOURCE,
    id: TASK_REMINDER_ID,
    label: "Tasks",
    priority: TASK_REMINDER_PRIORITY,
    ttl: "once",
    display: false,
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
  const widget = new DagTaskWidget(store, () => cfg);
  const autoArchive = new AutoArchiveManager(() => store, () => cfg.autoArchiveCompleted ?? "on_list_complete", AUTO_CLEAR_DELAY_TURNS);
  let currentTurn = 0;
  let storeReady = false;
  let suppressReminderUntilTurn = -1;
  let lastTaskToolTurn = 0;
  let lastTaskToolAt = Date.now();
  let lastReminderStateKey: string | undefined;
  let nextReminderTurn = TASK_REMINDER_FORGOTTEN_TURNS;

  function resolveCwd(ctx?: ExtensionContext): string {
    return ctx?.cwd ?? process.env.PWD ?? process.cwd();
  }

  function refreshConfig(cwd: string): void {
    delete cfg.taskScope;
    delete cfg.autoArchiveCompleted;
    delete cfg.animateActiveTasks;
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

  function publishTaskReminder(action: string): void {
    if (store.list().length === 0) {
      pi.events.emit(REMINDER_REMOVE_EVENT, taskReminderRemoveRequest());
      lastReminderStateKey = undefined;
      logReminderDecision(action, store);
      return;
    }

    const turnsSinceTaskTool = currentTurn - lastTaskToolTurn;
    const msSinceTaskTool = Date.now() - lastTaskToolAt;
    const due = currentTurn >= nextReminderTurn && msSinceTaskTool >= taskReminderForgottenMs();
    if (!due) {
      logReminderDecision("skip-not-due", store, undefined, {
        publishAction: action,
        currentTurn,
        nextReminderTurn,
        turnsSinceTaskTool,
        msSinceTaskTool,
      });
      return;
    }

    const reminder = buildReminder(store, turnsSinceTaskTool);
    if (!reminder) {
      pi.events.emit(REMINDER_REMOVE_EVENT, taskReminderRemoveRequest());
      lastReminderStateKey = undefined;
      logReminderDecision(action, store);
      return;
    }

    const stateKey = reminderStateKey(store);
    if (stateKey === lastReminderStateKey && currentTurn < nextReminderTurn) {
      logReminderDecision("skip-unchanged", store, undefined, { publishAction: action, currentTurn, nextReminderTurn });
      return;
    }

    pi.events.emit(REMINDER_UPSERT_EVENT, taskReminderIntent(reminder));
    lastReminderStateKey = stateKey;
    nextReminderTurn = currentTurn + TASK_REMINDER_FORGOTTEN_TURNS;
    logReminderDecision(action, store, reminder, { currentTurn, nextReminderTurn, turnsSinceTaskTool, msSinceTaskTool });
  }

  function suppressTaskReminder(action: string, toolName: string): void {
    lastTaskToolTurn = currentTurn;
    lastTaskToolAt = Date.now();
    suppressReminderUntilTurn = Math.max(suppressReminderUntilTurn, currentTurn + TASK_REMINDER_TOOL_COOLDOWN_TURNS);
    nextReminderTurn = Math.max(nextReminderTurn, currentTurn + TASK_REMINDER_FORGOTTEN_TURNS);
    pi.events.emit(REMINDER_REMOVE_EVENT, taskReminderRemoveRequest());
    lastReminderStateKey = undefined;
    logReminderDecision(action, store, undefined, {
      toolName,
      currentTurn,
      suppressUntilTurn: suppressReminderUntilTurn,
      nextReminderTurn,
    });
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
    if (currentTurn <= suppressReminderUntilTurn) {
      logReminderDecision("suppress-cooldown", store, undefined, { currentTurn, suppressUntilTurn: suppressReminderUntilTurn });
      return undefined;
    }
    publishTaskReminder("upsert");
    return undefined;
  });

  pi.on("turn_start", (_event, ctx) => {
    currentTurn++;
    ensureStore(ctx);
    if (autoArchive.onTurnStart(currentTurn)) store.deleteFileIfEmpty();
    refreshUi(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    if (TOOL_NAMES.has(event.toolName)) {
      ensureStore(ctx);
      suppressTaskReminder("suppress-before-tool-call", event.toolName);
    }
    return {};
  });

  pi.on("tool_result", (event, ctx) => {
    if (TOOL_NAMES.has(event.toolName)) {
      ensureStore(ctx);
      suppressTaskReminder("suppress-after-tool-result", event.toolName);
    }
    return {};
  });

  pi.registerTool({
    name: "task_manage",
    label: "Task Manage",
    description: "Manage Pi's task list: the durable todo/progress tracker for non-trivial work. Create/update it early, keep statuses current, and archive completed tasks when ready. Use action:'create' for single or batch creation via create/creates; dependencies use task IDs like '1', not titles.",
    promptSnippet: "Manage task list",
    promptGuidelines: [
      "This is Pi's single task/todo tracker. When tracking is appropriate, use task_manage instead of writing informal todo lists in prose.",
      "Use tasks for durable state, not ceremony: multi-step implementation, ambiguity, checkpoints, dependencies, verification, multiple user requests, discovered follow-up work, or work likely to span turns/context.",
      "Skip task_manage for trivial single-step edits, direct factual answers, or pure conversation.",
      "Create the smallest useful task set for the current execution slice; do not clone a whole roadmap, charter plan, or speculative future work into tasks.",
      "Right-size tasks as meaningful outcomes that can be started, blocked, completed, or verified; avoid both giant catch-all tasks and microscopic process tasks.",
      "Use action:'create' for both create and creates; there is no action:'creates'.",
      "Dependency fields blockedBy/blocks/addBlockedBy/addBlocks must contain task IDs like '1', not task titles; create first, then update dependencies if you need generated IDs.",
      "Use dependencies only when they change what can start next; blocked work is represented with blockedBy/blocks dependencies, not a separate blocked status.",
      "Normally keep one task in_progress per active worker. Multiple in_progress tasks are valid only for genuine parallel work or distinct owners/subagents.",
      "Task context is durable setup, not a running journal. Add it up front with constraints, relevant findings, expected inputs, and definition of done; update it only when durable new information changes how the task should be done or the original context is wrong/incomplete.",
      "Keep tasks outcome-oriented and verifiable, not microscopic. For tests, builds, lint, typecheck, manual review, or output inspection tasks, set metadata.kind = 'verification'.",
      "Do not create standalone tasks for tiny process/meta instructions like compress context, reply concisely, run final check, or summarize changes unless they are a real multi-step workflow phase; include them in the relevant task context/definition of done instead.",
      "Complete tasks as soon as their work is fully done; avoid batching status updates at the end.",
      "Only mark completed work that is actually finished; if verification is appropriate, complete after running it or record why it was skipped.",
      "Use action:'done_archive' when a finished task can be marked complete and archived in one operation; use separate complete/archive only when review should remain visible first.",
      "Archive completed tasks once they are ready to leave the active review surface.",
      "Use task_next for ready/unblocked work; prefer ready tasks in ID order and don't start blocked tasks.",
    ],
    parameters: TaskManageParams,
    renderShell: "self",
    async execute(_toolCallId, params: TaskManageParamsType, _signal, _onUpdate, ctx) {
      ensureStore(ctx);
      const lines: string[] = [];
      const operations: TaskOperation[] = [];
      const details: TaskManageResultDetails = { action: params.action, operations };
      const blockedBefore = new Set(store.list()
        .filter((task) => task.status === "pending" && store.openBlockers(task).length > 0)
        .map((task) => task.id));

      if (params.action === "create") {
        const inputs = [...(params.creates ?? []), ...(params.create ? [params.create] : [])];
        if (inputs.length === 0) throw new Error("create or creates is required");
        for (const input of inputs) {
          const { task, warnings } = store.create(input);
          if (task.status === "in_progress") widget.markActive(task.id, true);
          if (task.status === "completed") autoArchive.trackCompletion(task.id, currentTurn);
          const kind = task.status === "in_progress" ? "started" : task.status === "completed" ? "completed" : "created";
          operations.push({ kind, id: task.id, title: task.title, warnings });
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
          if (result.task) {
            const kind = patch.status === "in_progress" ? "started" : patch.status === "completed" ? "completed" : "updated";
            operations.push({ kind, id: result.task.id, title: result.task.title, changed: result.changed, warnings: result.warnings });
          } else {
            operations.push({ kind: "skipped", id: patch.id, warnings: result.warnings });
          }
          lines.push(result.task ? `Updated #${patch.id}: ${result.changed.join(", ") || "no fields"}${result.warnings.length ? ` (warning: ${result.warnings.join("; ")})` : ""}` : `Skipped #${patch.id}: ${result.warnings.join("; ")}`);
        }
      } else if (params.action === "complete") {
        const ids = params.ids ?? (params.id ? [params.id] : []);
        if (ids.length === 0) throw new Error("id or ids is required");
        for (const id of ids) {
          const result = store.update({ id, status: "completed" });
          widget.markActive(id, false);
          if (result.task) autoArchive.trackCompletion(id, currentTurn);
          operations.push(result.task ? { kind: "completed", id, title: result.task.title, changed: ["status"] } : { kind: "skipped", id, warnings: ["not found"] });
          lines.push(result.task ? `Completed #${id}` : `Skipped #${id}: not found`);
        }
      } else if (params.action === "done_archive") {
        const ids = params.ids ?? (params.id ? [params.id] : []);
        if (ids.length === 0) throw new Error("id or ids is required");
        for (const id of ids) {
          const result = store.update({ id, status: "completed" });
          widget.markActive(id, false);
          if (result.task) {
            autoArchive.trackCompletion(id, currentTurn);
            const title = result.task.title;
            store.archive([id]);
            operations.push({ kind: "done_archived", id, title, changed: ["status"] });
            lines.push(`Completed and archived #${id}`);
          } else {
            operations.push({ kind: "skipped", id, warnings: ["not found"] });
            lines.push(`Skipped #${id}: not found`);
          }
        }
      } else if (params.action === "archive") {
        const ids = params.ids ?? (params.id ? [params.id] : []);
        if (ids.length > 0) {
          const before = new Map(ids.map((id) => [id, store.get(id)]));
          const count = store.archive(ids);
          for (const id of ids) {
            widget.markActive(id, false);
            const task = before.get(id);
            operations.push(task ? { kind: "archived", id, title: task.title } : { kind: "skipped", id, warnings: ["not found"] });
          }
          lines.push(`Archived ${count} task(s)`);
        } else {
          const completed = store.list().filter((task) => task.status === "completed");
          const count = store.archiveCompleted();
          for (const task of completed) {
            widget.markActive(task.id, false);
            operations.push({ kind: "archived", id: task.id, title: task.title });
          }
          lines.push(`Archived ${count} task(s)`);
        }
      } else if (params.action === "purge") {
        const ids = params.ids ?? (params.id ? [params.id] : []);
        if (ids.length === 0) throw new Error("id or ids is required");
        const before = new Map(ids.map((id) => [id, store.get(id)]));
        const count = store.purge(ids);
        for (const id of ids) {
          widget.markActive(id, false);
          const task = before.get(id);
          operations.push(task ? { kind: "purged", id, title: task.title } : { kind: "skipped", id, warnings: ["not found"] });
        }
        lines.push(`Purged ${count}/${ids.length} task(s)`);
      } else if (params.action === "list") {
        lines.push(summarizeTasks(store, store.list(), params.includeCompleted ?? true, params.includeContext ?? false));
      } else if (params.action === "history") {
        const history = store.history(params.limit ?? 20, params.query);
        lines.push(summarizeHistory(history, params.includeContext ?? false));
        details.history = history;
      }

      const tasksAfter = store.list();
      if (!["list", "history"].includes(params.action)) {
        for (const task of tasksAfter) {
          if (blockedBefore.has(task.id) && task.status === "pending" && store.openBlockers(task).length === 0) {
            operations.push({ kind: "unblocked", id: task.id, title: task.title });
            lines.push(`Unblocked #${task.id}: ${task.title}`);
          }
        }
      }

      if (!["list", "history"].includes(params.action)) {
        const guidance = buildTaskManageGuidance(store);
        details.guidance = guidance;
        lines.push("", guidance);
      }

      store.deleteFileIfEmpty();
      refreshUi(ctx);
      details.tasks = tasksAfter;
      return textResult(lines.join("\n"), details);
    },
    renderCall: renderTaskManageCall,
    renderResult: renderTaskManageResult,
  });

  pi.registerTool({
    name: "task_next",
    label: "Task Next",
    description: "Return ready/unblocked tasks from Pi's task list and a compact summary.",
    promptSnippet: "Next ready tasks",
    promptGuidelines: ["Use after completing work or when resuming; prefer ready tasks in ID order and don't start blocked tasks."],
    parameters: TaskNextParams,
    renderShell: "self",
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
      const details: TaskNextResultDetails = { ready, active, blocked, completedCount: completed.length, totalCount: tasks.length };
      return textResult(lines.join("\n\n"), details);
    },
    renderCall: renderTaskNextCall,
    renderResult: renderTaskNextResult,
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
