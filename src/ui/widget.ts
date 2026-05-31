import { truncateToWidth } from "@earendil-works/pi-tui";
import type { DagTaskStore } from "../store.js";
import type { DagTasksConfig } from "../types.js";

interface ThemeLike {
  fg(color: string, text: string): string;
  strikethrough(text: string): string;
}

interface UiLike {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: undefined | ((tui: any, theme: ThemeLike) => { render(): string[]; invalidate(): void }), options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const MAX_BODY_ROWS = 8;
const COMPACT_COMPLETED_ROWS = 2;

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  if (minutes < 60) return rem ? `${minutes}m ${rem}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

export class DagTaskWidget {
  private ui?: UiLike;
  private frame = 0;
  private interval?: ReturnType<typeof setInterval>;
  private tui?: { terminal?: { columns?: number }; requestRender?: () => void };
  private registered = false;

  constructor(private store: DagTaskStore, private config: () => DagTasksConfig = () => ({})) {}

  setStore(store: DagTaskStore): void { this.store = store; }
  setUi(ui: UiLike): void { this.ui = ui; }

  markActive(_id: string, _active: boolean): void {
    this.update();
  }

  update(): void {
    if (!this.ui) return;
    const tasks = this.store.list();
    const open = tasks.filter((task) => task.status !== "completed").length;
    const inProgress = tasks.filter((task) => task.status === "in_progress").length;
    this.ui.setStatus("dag-tasks", tasks.length ? `tasks ${tasks.length}/${open} open${inProgress ? ` · ${inProgress} active` : ""}` : undefined);

    if (tasks.length === 0) {
      if (this.registered) this.ui.setWidget("dag-tasks", undefined);
      this.registered = false;
      this.stopTimer();
      return;
    }

    if (tasks.some((task) => task.status === "in_progress")) this.ensureTimer();
    else this.stopTimer();
    this.frame++;

    this.ui.setWidget("dag-tasks", (tui, theme) => {
      this.tui = tui;
      return { render: () => this.render(tui, theme), invalidate: () => {} };
    }, { placement: "aboveEditor" });
    this.registered = true;
    this.tui?.requestRender?.();
  }

  dispose(): void {
    this.stopTimer();
    this.ui?.setWidget("dag-tasks", undefined);
    this.ui?.setStatus("dag-tasks", undefined);
    this.registered = false;
  }

  private render(tui: { terminal?: { columns?: number } }, theme: ThemeLike): string[] {
    const width = tui.terminal?.columns ?? 100;
    const truncate = (line: string) => truncateToWidth(line, width);
    const tasks = this.store.list();
    if (tasks.length === 0) return [];
    const completed = tasks.filter((task) => task.status === "completed");
    const openTasks = tasks.filter((task) => task.status !== "completed");
    const active = openTasks.filter((task) => task.status === "in_progress").length;
    const compact = tasks.length > MAX_BODY_ROWS;
    const header = `Tasks · ${completed.length}/${tasks.length} done${active ? ` · ${active} active` : ""}`;
    const lines = [truncate(` ${theme.fg("accent", header)}`)];
    if (!compact) {
      for (const task of tasks) lines.push(truncate(this.renderTask(task, theme)));
      return [...lines, ""];
    }

    const recentCompletedIds = new Set(completed
      .slice()
      .sort((a, b) => ((b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt)) || (Number(b.id) - Number(a.id)))
      .slice(0, COMPACT_COMPLETED_ROWS)
      .map((task) => task.id));
    const visibleTasks = tasks.filter((task) => task.status !== "completed" || recentCompletedIds.has(task.id));
    let hiddenOpen = 0;
    while (visibleTasks.length + (hiddenOpen > 0 ? 1 : 0) > MAX_BODY_ROWS) {
      const removeAt = findLastIndex(visibleTasks, (task) => task.status !== "completed");
      if (removeAt === -1) break;
      visibleTasks.splice(removeAt, 1);
      hiddenOpen++;
    }
    for (const task of visibleTasks) lines.push(truncate(this.renderTask(task, theme)));
    if (hiddenOpen > 0) lines.push(truncate(theme.fg("dim", `  +${hiddenOpen} open`)));
    return [...lines, ""];
  }

  private renderTask(task: ReturnType<DagTaskStore["list"]>[number], theme: ThemeLike): string {
    const blockers = this.store.openBlockers(task);
    const isSpinning = task.status === "in_progress" && (this.config().animateActiveTasks ?? false);
    const icon = isSpinning ? theme.fg("accent", SPINNER[this.frame % SPINNER.length] ?? "✳")
      : task.status === "completed" ? theme.fg("success", "✔")
      : blockers.length ? theme.fg("warning", "◫")
      : task.status === "in_progress" ? theme.fg("accent", "◼") : theme.fg("muted", "◻");
    const id = theme.fg("dim", `#${task.id}`);
    const blocked = blockers.length ? ` ${theme.fg("warning", "!")} ${theme.fg("dim", `blocked by ${blockers.map((x) => `#${x}`).join(", ")}`)}` : "";
    if (task.status === "in_progress") {
      const elapsed = task.startedAt ? ` ${theme.fg("dim", `(${formatDuration(Date.now() - task.startedAt)})`)}` : "";
      return `  ${icon} ${id} ${theme.fg("accent", task.activeForm || task.title)}${elapsed}${blocked}`;
    }
    if (task.status === "completed") return `  ${icon} ${theme.fg("dim", theme.strikethrough(`#${task.id} ${task.title}`))}`;
    if (blockers.length) return `  ${icon} ${id} ${theme.fg("dim", task.title)}${blocked}`;
    return `  ${icon} ${id} ${theme.fg("muted", task.title)}${blocked}`;
  }

  private ensureTimer(): void {
    if (!this.interval) this.interval = setInterval(() => this.update(), this.config().animateActiveTasks ? 120 : 30_000);
  }

  private stopTimer(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}
