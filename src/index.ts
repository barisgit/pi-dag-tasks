import { createHash } from "node:crypto";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  connect,
  createLogger,
  type Logger,
  type ReminderIntent,
  type UtilsClient,
} from "pi-extension-utils";
import { AutoArchiveManager } from "./auto-clear.js";
import { loadConfig, saveConfig } from "./config.js";
import { DagTaskStore, type TaskPatch } from "./store.js";
import type { DagTask, DagTasksConfig, TaskQueryResultDetails, TaskMutationAction, TaskResultDetails, TaskOperation, TaskStatus } from "./types.js";
import {
  renderTaskCall,
  renderTaskQueryCall,
  renderTaskResult,
  renderTaskQueryResult,
} from "./ui/tool-render.js";
import { DagTaskWidget } from "./ui/widget.js";

const TOOL_NAMES = new Set(["task", "task_query"]);
const TASK_REMINDER_SOURCE = "pi-dag-tasks";
const TASK_REMINDER_ID = "state";
const TASK_REMINDER_PRIORITY = 20;
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
  activeForm: Type.Optional(Type.String({ description: "Deprecated compatibility field for resumed task sessions." })),
  blockedBy: Type.Optional(Type.Array(Type.String())),
  blocks: Type.Optional(Type.Array(Type.String())),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
}, { additionalProperties: false });

const TaskUpdateSchema = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  context: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum(["pending", "in_progress", "completed"] as const)),
  activeForm: Type.Optional(Type.String({ description: "Deprecated compatibility field for resumed task sessions." })),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Any())),
  addBlocks: Type.Optional(Type.Array(Type.String())),
  addBlockedBy: Type.Optional(Type.Array(Type.String())),
  removeBlocks: Type.Optional(Type.Array(Type.String())),
  removeBlockedBy: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

const TaskParams = Type.Object({
  action: StringEnum(["create", "update", "archive", "archive_all", "purge"] as const),
  creates: Type.Optional(Type.Array(TaskCreateSchema)),
  updates: Type.Optional(Type.Array(TaskUpdateSchema)),
  ids: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });

const TaskQueryParams = Type.Object({
  scope: StringEnum(["ready", "current", "history"] as const),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
  query: Type.Optional(Type.String()),
  includeCompleted: Type.Optional(Type.Boolean({ default: true })),
  includeContext: Type.Optional(Type.Boolean({ default: false })),
}, { additionalProperties: false });

type PublicTaskCreateInput = Parameters<DagTaskStore["create"]>[0];
type PublicTaskUpdateInput = TaskPatch;

type TaskParamsType = {
  action: "create" | "update" | "archive" | "archive_all" | "purge";
  creates?: PublicTaskCreateInput[];
  updates?: PublicTaskUpdateInput[];
  ids?: string[];
};

type TaskQueryParamsType = {
  scope: "ready" | "current" | "history";
  limit?: number;
  query?: string;
  includeCompleted?: boolean;
  includeContext?: boolean;
};

type RawTaskArguments = Record<string, unknown>;

function isRecord(value: unknown): value is RawTaskArguments {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function normalizeId(value: unknown): unknown {
  return typeof value === "number" && Number.isInteger(value) ? String(value) : value;
}

function normalizeIds(value: unknown): unknown[] | undefined {
  return asArray(value)?.map(normalizeId);
}

function normalizeLegacyEntry(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const entry = { ...value };
  // The old UI called this field inProgressForm; the store's durable name is activeForm.
  if (entry.inProgressForm !== undefined && entry.activeForm === undefined) {
    entry.activeForm = entry.inProgressForm;
    delete entry.inProgressForm;
  }
  if (entry.id !== undefined) entry.id = normalizeId(entry.id);
  return entry;
}

const topLevelUpdateFields = [
  "title",
  "description",
  "context",
  "status",
  "activeForm",
  "inProgressForm",
  "metadata",
  "addBlocks",
  "addBlockedBy",
  "removeBlocks",
  "removeBlockedBy",
] as const;

/**
 * Normalize unambiguous shapes emitted by older task prompts before Pi validates
 * the current strict schema. This keeps the public contract canonical while
 * allowing resumed sessions and common single-item calls to continue working.
 */
function prepareTaskArguments(args: unknown): TaskParamsType {
  if (!isRecord(args)) return args as TaskParamsType;

  const input = { ...args };
  const action = input.action;
  const hasAny = (...keys: string[]) => keys.some((key) => input[key] !== undefined);
  const rejectMixedAction = () => ({ ...input, action: "__invalid_task_arguments__" }) as unknown as TaskParamsType;

  if (action === "creates" && input.creates !== undefined) input.action = "create";
  if (action === "updates" && input.updates !== undefined) input.action = "update";

  switch (input.action) {
    case "create":
      if (hasAny("update", "updates", "ids", "id", "archive")) return rejectMixedAction();
      if (input.create !== undefined && input.creates !== undefined) return rejectMixedAction();
      break;
    case "update":
      if (hasAny("create", "creates", "ids", "archive")) return rejectMixedAction();
      if (input.update !== undefined && input.updates !== undefined) return rejectMixedAction();
      if (input.id !== undefined && input.updates !== undefined) return rejectMixedAction();
      break;
    case "archive":
      if (hasAny("create", "creates", "update", "updates")) return rejectMixedAction();
      if (input.archive !== undefined && hasAny("id", "ids")) return rejectMixedAction();
      if (input.id !== undefined && input.ids !== undefined) return rejectMixedAction();
      break;
    case "purge":
      if (hasAny("create", "creates", "update", "updates", "archive")) return rejectMixedAction();
      if (input.id !== undefined && input.ids !== undefined) return rejectMixedAction();
      break;
    case "archive_all":
      if (hasAny("create", "creates", "update", "updates", "ids", "id", "archive")) return rejectMixedAction();
      break;
    case "complete":
      if (hasAny("create", "creates", "update", "updates", "archive") || (input.id !== undefined && input.ids !== undefined)) return rejectMixedAction();
      break;
  }

  if (input.action === "complete" && !(input.ids !== undefined && input.id !== undefined)) {
    const ids = normalizeIds(input.ids ?? input.id);
    if (ids?.length) {
      input.action = "update";
      input.updates = ids.map((id) => ({ id, status: "completed" }));
      delete input.id;
      delete input.ids;
    }
  }

  if (input.action === "archive" && input.archive === "completed" && input.ids === undefined && input.id === undefined) {
    input.action = "archive_all";
    delete input.archive;
  }

  const hasSingularCreate = input.create !== undefined;
  const hasBatchCreate = input.creates !== undefined;
  if (!hasBatchCreate && hasSingularCreate) {
    input.creates = asArray(input.create)?.map(normalizeLegacyEntry);
    delete input.create;
  }
  if (input.creates !== undefined && !hasSingularCreate) {
    input.creates = asArray(input.creates)?.map(normalizeLegacyEntry);
  }

  const hasSingularUpdate = input.update !== undefined;
  const hasBatchUpdate = input.updates !== undefined;
  if (!hasBatchUpdate && hasSingularUpdate) {
    input.updates = asArray(input.update);
  }

  if (input.action === "update" && !hasSingularUpdate && !hasBatchUpdate && input.id !== undefined) {
    const update: RawTaskArguments = { id: normalizeId(input.id) };
    for (const field of topLevelUpdateFields) {
      if (input[field] !== undefined) {
        update[field] = input[field];
        delete input[field];
      }
    }
    if (Object.keys(update).length > 1) {
      input.updates = [update];
      delete input.id;
    }
  }

  if (input.updates !== undefined && !(hasSingularUpdate && hasBatchUpdate)) {
    const updates = asArray(input.updates)?.map(normalizeLegacyEntry) ?? [];
    if (hasSingularUpdate && !Array.isArray(input.update) && input.id !== undefined && updates.length === 1 && isRecord(updates[0]) && updates[0].id === undefined) {
      updates[0] = { ...updates[0], id: normalizeId(input.id) };
      delete input.id;
    }
    input.updates = updates;
    delete input.update;
  }

  if (input.ids !== undefined) {
    input.ids = normalizeIds(input.ids);
  } else if ((input.action === "archive" || input.action === "purge") && input.id !== undefined) {
    input.ids = [normalizeId(input.id)];
    delete input.id;
  }

  return input as TaskParamsType;
}

function prepareTaskQueryArguments(args: unknown): TaskQueryParamsType {
  if (!isRecord(args)) return args as TaskQueryParamsType;
  if (args.scope === "active" || args.scope === "list") return { ...args, scope: "current" } as TaskQueryParamsType;
  if (args.scope === "next") return { ...args, scope: "ready" } as TaskQueryParamsType;
  return args as TaskQueryParamsType;
}

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

function inProgressTaskLabel(task: DagTask, now = Date.now()): string {
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

function taskStatePrefix(inProgress: DagTask[], ready: DagTask[], blocked: DagTask[], completed: number): string {
  return [
    inProgress.length ? countLabel(inProgress.length, "in_progress", "in_progress") : undefined,
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

  const inProgress = tasks.filter((task) => task.status === "in_progress");
  const ready = store.ready();
  const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0);
  const prefix = taskStatePrefix(inProgress, ready, blocked, completed);
  const state = prefix ? `${prefix}. ` : "";

  if (inProgress.length > 0) {
    const primary = inProgress[0];
    const readyText = ready.length ? ` Ready after that: #${ready[0].id}.` : "";
    return `${state}Next: continue in_progress #${primary.id} ${primary.title}.${readyText}`;
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
  const inProgress = tasks.filter((task) => task.status === "in_progress");
  const ready = store.ready();
  const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const open = tasks.length - completed;
  if (open === 0) {
    const parts = [`Task checkpoint: all tasks are completed after ${turnsSinceTaskTool} turns without task-tool use. Verify if appropriate; archive completed tasks when ready.`];
    if (shouldNudgeVerification(tasks)) parts.push("No verification task is recorded. Verify the work if practical, or state why verification was not run before finalizing.");
    return parts.join("\n");
  }
  if (inProgress[0]) {
    const parts = [`Task checkpoint: ${turnsSinceTaskTool} turns since task tools. Continue or complete in_progress ${inProgressTaskLabel(inProgress[0])}.`];
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
  const in_progress = tasks.filter((task) => task.status === "in_progress").length;
  const ready = store.ready().length;
  const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0).length;
  return {
    total: tasks.length,
    open: tasks.length - completed,
    in_progress,
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
  logger: Logger,
  action: string,
  store: DagTaskStore,
  text?: string,
  extra: Record<string, unknown> = {},
): void {
  try {
    const fields: Record<string, unknown> = {
      event: "task_reminder_decision",
      action,
      taskCounts: taskCounts(store),
      ...extra,
    };
    if (text !== undefined) {
      fields.textChars = text.length;
      fields.textHash = textHash(text);
      fields.textPreview = textPreview(text);
    }
    logger.log("info", action, fields);
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

export default function dagTasksExtension(pi: ExtensionAPI): void {
  const cfg: DagTasksConfig = {};
  let store = new DagTaskStore();
  const logger = createLogger("pi-dag-tasks", process.env.PI_DAG_TASKS_DEBUG_LOG ? { dir: process.env.PI_DAG_TASKS_DEBUG_LOG } : {});
  let utilsClient: UtilsClient | undefined;
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
    delete cfg.autoArchiveCompleted;
    delete cfg.animateActiveTasks;
    Object.assign(cfg, loadConfig(cwd));
  }

  function ensureStore(ctx: ExtensionContext): void {
    if (storeReady) return;
    const cwd = resolveCwd(ctx);
    const sessionId = ctx.sessionManager.getSessionId?.() ?? "session";
    refreshConfig(cwd);
    store.setFilePath(join(cwd, ".pi", "dag-tasks", `tasks-${sessionId}.json`));
    storeReady = true;
    widget.setStore(store);
  }

  function ensureUtilsClient(ctx: ExtensionContext): UtilsClient {
    if (!utilsClient) utilsClient = connect(pi, { ctx, clientId: "pi-dag-tasks" });
    return utilsClient;
  }

  function refreshUi(ctx?: ExtensionContext): void {
    if (ctx?.hasUI) {
      const client = ensureUtilsClient(ctx);
      widget.setHost({ setStatus: (key, text) => ctx.ui.setStatus(key, text), widgets: client.widgets });
    }
    widget.update();
  }

  function publishTaskReminder(action: string): void {
    const reminders = utilsClient?.reminders;
    if (store.list().length === 0) {
      reminders?.remove(TASK_REMINDER_SOURCE, TASK_REMINDER_ID);
      lastReminderStateKey = undefined;
      logReminderDecision(logger, action, store);
      return;
    }

    const turnsSinceTaskTool = currentTurn - lastTaskToolTurn;
    const msSinceTaskTool = Date.now() - lastTaskToolAt;
    const due = currentTurn >= nextReminderTurn && msSinceTaskTool >= taskReminderForgottenMs();
    if (!due) {
      logReminderDecision(logger, "skip-not-due", store, undefined, {
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
      reminders?.remove(TASK_REMINDER_SOURCE, TASK_REMINDER_ID);
      lastReminderStateKey = undefined;
      logReminderDecision(logger, action, store);
      return;
    }

    const stateKey = reminderStateKey(store);
    if (stateKey === lastReminderStateKey && currentTurn < nextReminderTurn) {
      logReminderDecision(logger, "skip-unchanged", store, undefined, { publishAction: action, currentTurn, nextReminderTurn });
      return;
    }

    reminders?.upsert(taskReminderIntent(reminder));
    lastReminderStateKey = stateKey;
    nextReminderTurn = currentTurn + TASK_REMINDER_FORGOTTEN_TURNS;
    logReminderDecision(logger, action, store, reminder, { currentTurn, nextReminderTurn, turnsSinceTaskTool, msSinceTaskTool });
  }

  function suppressTaskReminder(action: string, toolName: string): void {
    lastTaskToolTurn = currentTurn;
    lastTaskToolAt = Date.now();
    suppressReminderUntilTurn = Math.max(suppressReminderUntilTurn, currentTurn + TASK_REMINDER_TOOL_COOLDOWN_TURNS);
    nextReminderTurn = Math.max(nextReminderTurn, currentTurn + TASK_REMINDER_FORGOTTEN_TURNS);
    utilsClient?.reminders.remove(TASK_REMINDER_SOURCE, TASK_REMINDER_ID);
    lastReminderStateKey = undefined;
    logReminderDecision(logger, action, store, undefined, {
      toolName,
      currentTurn,
      suppressUntilTurn: suppressReminderUntilTurn,
      nextReminderTurn,
    });
  }

  pi.on("session_start", (_event, ctx) => {
    storeReady = false;
    ensureStore(ctx);
    ensureUtilsClient(ctx);
    refreshUi(ctx);
  });

  pi.on("session_shutdown", () => {
    widget.dispose();
    utilsClient?.dispose();
  });

  pi.on("context", (_event, ctx) => {
    ensureStore(ctx);
    ensureUtilsClient(ctx);
    refreshUi(ctx);
    if (currentTurn <= suppressReminderUntilTurn) {
      logReminderDecision(logger, "suppress-cooldown", store, undefined, { currentTurn, suppressUntilTurn: suppressReminderUntilTurn });
      return undefined;
    }
    publishTaskReminder("upsert");
    return undefined;
  });

  pi.on("turn_start", (_event, ctx) => {
    currentTurn++;
    ensureStore(ctx);
    ensureUtilsClient(ctx);
    if (autoArchive.onTurnStart(currentTurn)) {
      logger.info("auto_archive", { archived: "completed-batch" });
      store.deleteFileIfEmpty();
    }
    refreshUi(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    if (TOOL_NAMES.has(event.toolName)) {
      ensureStore(ctx);
      ensureUtilsClient(ctx);
      suppressTaskReminder("suppress-before-tool-call", event.toolName);
    }
    return {};
  });

  pi.on("tool_result", (event, ctx) => {
    if (TOOL_NAMES.has(event.toolName)) {
      ensureStore(ctx);
      ensureUtilsClient(ctx);
      suppressTaskReminder("suppress-after-tool-result", event.toolName);
    }
    return {};
  });

  pi.registerTool({
    name: "task",
    label: "Task",
    description: "Manage Pi's task list (mutations): the durable todo/progress tracker for non-trivial work. Actions: create, update, archive, archive_all, purge. Batch-only — create reads creates[], update reads updates[], archive/purge read ids[], archive_all takes no args. To complete a task, update with status:'completed'. Dependencies use task IDs like '1', not titles.",
    promptSnippet: "Manage task list",
    promptGuidelines: [
      "Use task for durable multi-step work; skip trivial single-step edits, direct factual answers, and pure conversation.",
      "Keep the current execution slice small and tasks outcome-oriented: avoid whole-roadmap copies, catch-all tasks, microscopic process notes, and informal todo lists.",
      "Inputs are batch-only: create uses creates[], update uses updates[] with an id, archive/purge use ids[], and archive_all takes no arguments. Complete work through update with status:'completed'.",
      "Dependencies contain task IDs, not titles; use them only when they change what can start. Keep one task in_progress per active worker unless work is genuinely parallel.",
      "Task context is durable setup—constraints, findings, inputs, and definition of done—not a running journal.",
      "Use metadata.kind:'verification' for checks, and mark work completed only when it is finished and appropriately verified.",
      "Use task_query with scope:'ready' for executable work; prefer ready tasks in ID order and do not start blocked tasks.",
    ],
    parameters: TaskParams,
    prepareArguments: prepareTaskArguments,
    renderShell: "self",
    async execute(_toolCallId, params: TaskParamsType, _signal, _onUpdate, ctx) {
      ensureStore(ctx);
      const lines: string[] = [];
      const operations: TaskOperation[] = [];
      const details: TaskResultDetails = { action: params.action, operations };
      const blockedBefore = new Set(store.list()
        .filter((task) => task.status === "pending" && store.openBlockers(task).length > 0)
        .map((task) => task.id));

      if (params.action === "create") {
        const inputs = params.creates ?? [];
        if (inputs.length === 0) throw new Error("creates is required");
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
        const updates = params.updates ?? [];
        if (updates.length === 0) throw new Error("updates is required");
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
      } else if (params.action === "archive") {
        const ids = params.ids ?? [];
        if (ids.length === 0) throw new Error("ids is required");
        const before = new Map(ids.map((id) => [id, store.get(id)]));
        const count = store.archive(ids);
        for (const id of ids) {
          widget.markActive(id, false);
          const task = before.get(id);
          operations.push(task ? { kind: "archived", id, title: task.title } : { kind: "skipped", id, warnings: ["not found"] });
        }
        lines.push(`Archived ${count}/${ids.length} task(s)`);
      } else if (params.action === "archive_all") {
        const completed = store.list().filter((task) => task.status === "completed");
        const count = store.archiveCompleted();
        for (const task of completed) {
          widget.markActive(task.id, false);
          operations.push({ kind: "archived", id: task.id, title: task.title });
        }
        lines.push(`Archived ${count} task(s)`);
      } else if (params.action === "purge") {
        const ids = params.ids ?? [];
        if (ids.length === 0) throw new Error("ids is required");
        const before = new Map(ids.map((id) => [id, store.get(id)]));
        const count = store.purge(ids);
        for (const id of ids) {
          widget.markActive(id, false);
          const task = before.get(id);
          operations.push(task ? { kind: "purged", id, title: task.title } : { kind: "skipped", id, warnings: ["not found"] });
        }
        lines.push(`Purged ${count}/${ids.length} task(s)`);
      }

      const tasksAfter = store.list();
      for (const task of tasksAfter) {
        if (blockedBefore.has(task.id) && task.status === "pending" && store.openBlockers(task).length === 0) {
          operations.push({ kind: "unblocked", id: task.id, title: task.title });
          lines.push(`Unblocked #${task.id}: ${task.title}`);
        }
      }

      logger.info("task", { action: params.action, ops: operations.map((op) => op.kind) });
      const guidance = buildTaskManageGuidance(store);
      details.guidance = guidance;
      lines.push("", guidance);

      store.deleteFileIfEmpty();
      refreshUi(ctx);
      details.tasks = tasksAfter;
      return textResult(lines.join("\n"), details);
    },
    renderCall: renderTaskCall,
    renderResult: renderTaskResult,
  });

  pi.registerTool({
    name: "task_query",
    label: "Task Query",
    description: "Read Pi's task list. scope:'ready' returns unblocked pending + in_progress tasks plus a summary; scope:'current' returns the current list; scope:'history' returns archived tasks newest-first. Optional: limit, query, includeCompleted (default true), includeContext (default false).",
    promptSnippet: "Query task list",
    promptGuidelines: [
      "Use scope:'ready' for executable work, scope:'current' to review the current list, and scope:'history' for archived work; set includeContext:true when durable setup is needed.",
    ],
    parameters: TaskQueryParams,
    prepareArguments: prepareTaskQueryArguments,
    renderShell: "self",
    async execute(_toolCallId, params: TaskQueryParamsType, _signal, _onUpdate, ctx) {
      ensureStore(ctx);
      const includeCompleted = params.includeCompleted ?? true;
      const includeContext = params.includeContext ?? false;

      if (params.scope === "ready") {
        const limit = params.limit ?? 5;
        const tasks = store.list();
        const allReady = store.ready();
        const ready = allReady.slice(0, limit);
        const inProgress = tasks.filter((task) => task.status === "in_progress");
        const blocked = tasks.filter((task) => task.status === "pending" && store.openBlockers(task).length > 0);
        const completed = tasks.filter((task) => task.status === "completed");
        const lines = [`Summary: ${tasks.length} total, ${allReady.length} ready, ${inProgress.length} in_progress, ${blocked.length} blocked, ${completed.length} completed.`];
        if (inProgress.length) lines.push(`In progress:\n${summarizeTasks(store, inProgress, true, includeContext)}`);
        lines.push(ready.length ? `Ready:\n${summarizeTasks(store, ready, true, includeContext)}` : "Ready: none");
        lines.push(blocked.length ? `Blocked:\n${summarizeTasks(store, blocked, true)}` : "Blocked: none");
        const details: TaskQueryResultDetails = { scope: "ready", ready, inProgress, blocked, completedCount: completed.length, totalCount: tasks.length };
        return textResult(lines.join("\n\n"), details);
      }

      if (params.scope === "current") {
        const tasks = store.list();
        const visible = includeCompleted ? tasks : tasks.filter((task) => task.status !== "completed");
        const lines = [summarizeTasks(store, visible, includeCompleted, includeContext)];
        const details: TaskQueryResultDetails = { scope: "current", tasks: visible };
        return textResult(lines.join("\n"), details);
      }

      // scope "history"
      const history = store.history(params.limit ?? 20, params.query);
      const lines = [summarizeHistory(history, includeContext)];
      const details: TaskQueryResultDetails = { scope: "history", history };
      return textResult(lines.join("\n"), details);
    },
    renderCall: renderTaskQueryCall,
    renderResult: renderTaskQueryResult,
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
          const emptyChoice = await ctx.ui.select("No current tasks", ["View archived tasks", "← Back"]);
          return emptyChoice === "View archived tasks" ? viewHistory() : main();
        }
        const selected = await ctx.ui.select("Current tasks", [...tasks.map((task) => `${statusIcon(task.status)} #${task.id} [${task.status}] ${task.title}`), "← Back"]);
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
