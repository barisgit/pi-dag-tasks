import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import type { UtilsClient } from "pi-extension-utils";
import type { DagTaskStore } from "../store.js";
import type { DagTasksConfig } from "../types.js";

interface ThemeLike {
  fg(color: string, text: string): string;
  strikethrough(text: string): string;
}

interface WidgetHost {
  setStatus(key: string, text: string | undefined): void;
  widgets: UtilsClient["widgets"];
}

const WIDGET_KEY = "dag-tasks";
const WIDGET_PLACEMENT = "aboveEditor";
const WIDGET_ORDER = 20;
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
  private host?: WidgetHost;
  private frame = 0;
  private interval?: ReturnType<typeof setInterval>;
  private tui?: TUI;
  private registered = false;
  // Timestamp used for elapsed-time display, refreshed only on update() so that
  // incidental TUI re-renders (e.g. the loader spinner) do not tick it per-second.
  private displayNow = Date.now();

  constructor(private store: DagTaskStore, private config: () => DagTasksConfig = () => ({})) {}

  setStore(store: DagTaskStore): void { this.store = store; }
  setHost(host: WidgetHost): void { this.host = host; }

  markActive(_id: string, _active: boolean): void {
    this.update();
  }

  update(): void {
    if (!this.host) return;
    const tasks = this.store.list();
    const open = tasks.filter((task) => task.status !== "completed").length;
    const inProgress = tasks.filter((task) => task.status === "in_progress").length;
    this.host.setStatus(WIDGET_KEY, tasks.length ? `tasks ${tasks.length}/${open} open${inProgress ? ` · ${inProgress} in_progress` : ""}` : undefined);

    if (tasks.length === 0) {
      if (this.registered) {
        this.host.widgets.remove(WIDGET_PLACEMENT, WIDGET_KEY);
        this.registered = false;
      }
      this.stopTimer();
      return;
    }

    // Register the factory once; the host stores the component and calls
    // render(width) on each render cycle, so live state is read via `this`.
    if (!this.registered) {
      this.host.widgets.set(
        WIDGET_PLACEMENT,
        WIDGET_KEY,
        (tui, theme) => {
          this.tui = tui;
          const themeLike = theme as ThemeLike;
          return {
            render: (width: number) => this.render(width, themeLike),
            invalidate: () => {},
          };
        },
        { order: WIDGET_ORDER },
      );
      this.registered = true;
    }

    this.displayNow = Date.now();
    if (tasks.some((task) => task.status === "in_progress")) this.ensureTimer();
    else this.stopTimer();
    this.frame++;
    this.tui?.requestRender();
  }

  dispose(): void {
    this.stopTimer();
    if (this.registered) {
      this.host?.widgets.remove(WIDGET_PLACEMENT, WIDGET_KEY);
      this.registered = false;
    }
    this.host?.setStatus(WIDGET_KEY, undefined);
  }

  private render(width: number, theme: ThemeLike): string[] {
    const truncate = (line: string) => truncateToWidth(line, width);
    const tasks = this.store.list();
    if (tasks.length === 0) return [];
    const completed = tasks.filter((task) => task.status === "completed");
    const openTasks = tasks.filter((task) => task.status !== "completed");
    const inProgress = openTasks.filter((task) => task.status === "in_progress").length;
    const compact = tasks.length > MAX_BODY_ROWS;
    const header = `Tasks · ${completed.length}/${tasks.length} done${inProgress ? ` · ${inProgress} in_progress` : ""}`;
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
      const elapsed = task.startedAt ? ` ${theme.fg("dim", `(${formatDuration(this.displayNow - task.startedAt)})`)}` : "";
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
