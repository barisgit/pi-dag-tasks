import { Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ArchivedDagTask, DagTask, TaskResultDetails, TaskQueryResultDetails, TaskOperation, TaskOperationKind } from "../types.js";

interface RenderResultLike {
  content?: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

const HEADER_INDENT = " ";
const ROW_INDENT = "  ";
const DETAIL_INDENT = "    ";
const SECTION_RULE = "────────────";

function toolMarker(theme: Theme): string {
  return `${HEADER_INDENT}${theme.fg("accent", "●")} `;
}

function fallbackText(result: RenderResultLike): string {
  const first = result.content?.[0];
  return first?.type === "text" ? first.text ?? "" : "";
}

function insetText(text: string): string {
  return text.split("\n").map((line) => line ? `${HEADER_INDENT}${line}` : line).join("\n");
}

function looksLikeToolError(text: string): boolean {
  return /^\s*(Validation failed|Error|Tool error|Unhandled error)\b/i.test(text);
}

function renderFallbackResult(result: RenderResultLike, toolName: string, theme: Theme): string {
  const text = fallbackText(result);
  if (!text) return "";
  if (!result.isError && !looksLikeToolError(text)) return insetText(text);

  const lines = [`${toolMarker(theme)}${theme.fg("error", `Tool error · ${toolName}`)}`];
  for (const line of text.split("\n")) {
    lines.push(`${ROW_INDENT}${theme.fg("error", "│")} ${line ? theme.fg("dim", line) : ""}`.trimEnd());
  }
  return lines.join("\n");
}

function renderHeaderFromCounts(completed: number, total: number, active: number, theme: Theme): string {
  return `${toolMarker(theme)}${theme.fg("accent", `Tasks · ${completed}/${total} done${active ? ` · ${active} active` : ""}`)}`;
}

function renderHeader(tasks: DagTask[], theme: Theme): string {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const active = tasks.filter((task) => task.status === "in_progress").length;
  return renderHeaderFromCounts(completed, tasks.length, active, theme);
}

function openBlockers(task: DagTask, allTasks: DagTask[]): string[] {
  const tasksById = new Map(allTasks.map((candidate) => [candidate.id, candidate]));
  return task.blockedBy.filter((id) => tasksById.get(id)?.status !== "completed");
}

function renderTaskIcon(task: DagTask, blockers: string[], theme: Theme): string {
  if (task.status === "completed") return theme.fg("success", "✔");
  if (blockers.length) return theme.fg("warning", "◫");
  if (task.status === "in_progress") return theme.fg("accent", "◼");
  return "◻";
}

function renderDependencyHint(task: DagTask, allTasks: DagTask[], theme: Theme): string {
  const blockers = openBlockers(task, allTasks);
  if (blockers.length) return ` ${theme.fg("warning", "!")} ${theme.fg("dim", `blocked by ${blockers.map((blocker) => `#${blocker}`).join(", ")}`)}`;
  if (task.blocks.length) return ` ${theme.fg("dim", `blocks ${task.blocks.map((blocked) => `#${blocked}`).join(", ")}`)}`;
  return "";
}

function renderTaskLine(task: DagTask, allTasks: DagTask[], theme: Theme): string {
  const blockers = openBlockers(task, allTasks);
  const icon = renderTaskIcon(task, blockers, theme);
  const id = theme.fg("dim", `#${task.id}`);
  const dependency = renderDependencyHint(task, allTasks, theme);

  if (task.status === "completed") return `${ROW_INDENT}${icon} ${theme.fg("dim", theme.strikethrough(`#${task.id} ${task.title}`))}`;
  if (task.status === "in_progress") return `${ROW_INDENT}${icon} ${id} ${theme.fg("accent", task.activeForm || task.title)}${dependency}`;
  if (blockers.length) return `${ROW_INDENT}${icon} ${id} ${theme.fg("dim", task.title)}${dependency}`;
  return `${ROW_INDENT}${icon} ${id} ${theme.fg("muted", task.title)}${dependency}`;
}

function operationIcon(kind: TaskOperationKind, theme: Theme): string {
  if (kind === "skipped") return theme.fg("warning", "!");
  if (kind === "purged") return theme.fg("error", "−");
  if (kind === "archived") return theme.fg("dim", "◌");
  if (kind === "started") return theme.fg("accent", "◼");
  if (kind === "completed") return theme.fg("success", "✔");
  if (kind === "unblocked") return theme.fg("success", "◻");
  return theme.fg("muted", "◻");
}

function operationVerb(kind: TaskOperationKind): string {
  switch (kind) {
    case "created": return "Added";
    case "started": return "Started";
    case "completed": return "Done";
    case "updated": return "Updated";
    case "unblocked": return "Unblocked";
    case "archived": return "Archived";
    case "purged": return "Removed";
    case "skipped": return "Skipped";
  }
}

function manageHeader(action: TaskResultDetails["action"]): string {
  switch (action) {
    case "create": return "Tasks added";
    case "update": return "Tasks updated";
    case "archive": return "Tasks archived";
    case "archive_all": return "Tasks archived";
    case "purge": return "Tasks removed";
    default: return "Tasks updated";
  }
}

function renderOperationLine(operation: TaskOperation, allTasks: DagTask[], theme: Theme): string {
  const icon = operationIcon(operation.kind, theme);
  const id = operation.id ? `${theme.fg("dim", `#${operation.id}`)} ` : "";
  const title = operation.title ? operation.title : operation.count !== undefined ? `${operation.count}${operation.total !== undefined ? `/${operation.total}` : ""} tasks` : "";
  const warning = operation.kind === "skipped" && operation.warnings?.length ? theme.fg("warning", operation.warnings.join("; ")) : "";
  const changed = operation.kind === "updated" && operation.changed?.length ? theme.fg("dim", ` (${operation.changed.join(", ")})`) : "";
  const task = operation.id ? allTasks.find((candidate) => candidate.id === operation.id) : undefined;
  const dependency = task ? renderDependencyHint(task, allTasks, theme) : "";
  const body = `${operationVerb(operation.kind)} ${id}${title || warning}`.trim();
  return `${ROW_INDENT}${icon}${body ? ` ${body}${changed}${dependency}` : ""}`;
}

function renderOperationWarnings(operation: TaskOperation, theme: Theme): string[] {
  if (!operation.warnings?.length || operation.kind === "skipped") return [];
  return operation.warnings.map((warning) => `${DETAIL_INDENT}${theme.fg("warning", `! ${warning}`)}`);
}

function renderTaskSnapshot(tasks: DagTask[], theme: Theme, limit = 20): string[] {
  const lines = [renderHeader(tasks, theme)];
  for (const task of tasks.slice(0, limit)) lines.push(renderTaskLine(task, tasks, theme));
  if (tasks.length > limit) lines.push(`${ROW_INDENT}${theme.fg("dim", `+${tasks.length - limit} more`)}`);
  return lines;
}

export function renderTaskCall(_args: { action?: string }, _theme: Theme) {
  return new Spacer(0);
}

export function renderTaskResult(result: RenderResultLike, { expanded }: { expanded?: boolean }, theme: Theme) {
  const details = result.details as TaskResultDetails | undefined;
  const operations = details?.operations ?? [];

  if (!operations.length) {
    return new Text(renderFallbackResult(result, "task", theme), 0, 0);
  }

  const allTasks = details?.tasks ?? [];
  const lines = [`${toolMarker(theme)}${theme.fg("toolTitle", manageHeader(details?.action))}`];

  for (const operation of operations) {
    lines.push(renderOperationLine(operation, allTasks, theme));
    lines.push(...renderOperationWarnings(operation, theme));
  }

  if (expanded && allTasks.length) {
    lines.push(`${ROW_INDENT}${theme.fg("dim", SECTION_RULE)}`);
    lines.push(`${ROW_INDENT}${theme.fg("toolTitle", "Current state")}`);
    lines.push(...renderTaskSnapshot(allTasks, theme, 100).slice(1));
  }

  if (expanded && details?.guidance) lines.push(`${ROW_INDENT}${theme.fg("dim", details.guidance)}`);

  return new Text(lines.join("\n"), 0, 0);
}

export function renderTaskQueryCall(_args: { scope?: string }, _theme: Theme) {
  return new Spacer(0);
}

function renderArchiveSnapshot(records: ArchivedDagTask[], theme: Theme): string[] {
  const lines = [`${toolMarker(theme)}${theme.fg("toolTitle", "Task history")}${theme.fg("dim", ` · ${records.length} archived`)}`];
  for (const record of records.slice(0, 100)) {
    lines.push(`${ROW_INDENT}${theme.fg("dim", "◌")} ${theme.fg("dim", `#${record.task.id} ${record.task.title}`)}`);
  }
  return lines;
}

export function renderTaskQueryResult(result: RenderResultLike, { expanded }: { expanded?: boolean }, theme: Theme) {
  const details = result.details as TaskQueryResultDetails | undefined;
  if (!details) return new Text(renderFallbackResult(result, "task_query", theme), 0, 0);

  if (details.scope === "history") {
    const history = details.history ?? [];
    if (!history.length) return new Text(renderFallbackResult(result, "task_query", theme), 0, 0);
    return new Text(renderArchiveSnapshot(history, theme).join("\n"), 0, 0);
  }

  if (details.scope === "active") {
    const tasks = details.tasks ?? [];
    return new Text(renderTaskSnapshot(tasks, theme, expanded ? 100 : 20).join("\n"), 0, 0);
  }

  // scope "ready"
  const ready = details.ready ?? [];
  const active = details.active ?? [];
  const blocked = details.blocked ?? [];
  const visible = [...active, ...ready, ...(expanded || blocked.length ? blocked : [])];
  const allTasks = visible;
  const completedCount = details.completedCount ?? 0;
  const total = details.totalCount ?? completedCount + active.length + ready.length + blocked.length;
  const lines = [`${toolMarker(theme)}${theme.fg("toolTitle", "Next tasks")}${theme.fg("dim", ` · ${completedCount}/${total} done${active.length ? ` · ${active.length} active` : ""}`)}`];

  if (visible.length) {
    for (const task of visible) lines.push(renderTaskLine(task, allTasks, theme));
  } else {
    lines.push(`${ROW_INDENT}${theme.fg("dim", "none")}`);
  }

  return new Text(lines.join("\n"), 0, 0);
}
