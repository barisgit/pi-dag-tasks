import { truncateToWidth } from "@mariozechner/pi-tui";
import type { DagTaskStore } from "../store.js";

interface ThemeLike {
  fg(color: string, text: string): string;
  strikethrough(text: string): string;
}

interface UiLike {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: undefined | ((tui: any, theme: ThemeLike) => { render(): string[]; invalidate(): void }), options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

const SPINNER = ["✳", "✴", "✵", "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽"];
const MAX_VISIBLE = 10;
const COMPACT_VISIBLE_OPEN = 6;
const COMPACT_VISIBLE_COMPLETED = 4;

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

export class DagTaskWidget {
  private ui?: UiLike;
  private frame = 0;
  private interval?: ReturnType<typeof setInterval>;
  private tui?: { terminal?: { columns?: number }; requestRender?: () => void };
  private registered = false;
  private activeSince = new Map<string, number>();

  constructor(private store: DagTaskStore) {}

  setStore(store: DagTaskStore): void { this.store = store; }
  setUi(ui: UiLike): void { this.ui = ui; }

  markActive(id: string, active: boolean): void {
    if (active) {
      if (!this.activeSince.has(id)) this.activeSince.set(id, Date.now());
      this.ensureTimer();
    } else {
      this.activeSince.delete(id);
    }
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

    for (const id of [...this.activeSince.keys()]) {
      const task = this.store.get(id);
      if (!task || task.status !== "in_progress") this.activeSince.delete(id);
    }
    if (this.activeSince.size > 0) this.ensureTimer();
    else this.stopTimer();
    this.frame++;

    if (!this.registered) {
      this.ui.setWidget("dag-tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.render(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.registered = true;
    } else {
      this.tui?.requestRender?.();
    }
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
    const compact = tasks.length > MAX_VISIBLE;
    const lines = [truncate(`${theme.fg("accent", "●")} ${theme.fg("accent", `${openTasks.length}/${tasks.length} tasks open${active ? ` · ${active} in progress` : ""}`)}`)];
    if (!compact) {
      for (const task of tasks.slice(0, MAX_VISIBLE)) lines.push(truncate(this.renderTask(task, theme)));
      return [...lines, ""];
    }

    const visible = this.compactVisibleCounts(openTasks.length, completed.length);
    for (const task of completed.slice(0, visible.completed)) lines.push(truncate(this.renderTask(task, theme)));
    const hiddenCompleted = completed.length - visible.completed;
    if (hiddenCompleted > 0) lines.push(truncate(theme.fg("dim", `  +${hiddenCompleted} more completed`)));

    for (const task of openTasks.slice(0, visible.open)) lines.push(truncate(this.renderTask(task, theme)));
    const hiddenOpen = openTasks.length - visible.open;
    if (hiddenOpen > 0) lines.push(truncate(theme.fg("dim", `  +${hiddenOpen} pending`)));
    return [...lines, ""];
  }

  private compactVisibleCounts(openCount: number, completedCount: number): { open: number; completed: number } {
    let completed = Math.min(COMPACT_VISIBLE_COMPLETED, completedCount);
    let open = Math.min(COMPACT_VISIBLE_OPEN, openCount);
    const rowCount = () => completed + (completedCount > completed ? 1 : 0) + open + (openCount > open ? 1 : 0);
    while (rowCount() > MAX_VISIBLE && open > 0) open--;
    while (rowCount() > MAX_VISIBLE && completed > 0) completed--;
    return { open, completed };
  }

  private renderTask(task: ReturnType<DagTaskStore["list"]>[number], theme: ThemeLike): string {
    const blockers = this.store.openBlockers(task);
    const isSpinning = task.status === "in_progress" && this.activeSince.has(task.id);
    const icon = isSpinning ? theme.fg("accent", SPINNER[this.frame % SPINNER.length] ?? "✳")
      : task.status === "completed" ? theme.fg("success", "✔")
      : task.status === "in_progress" ? theme.fg("accent", "◼") : "◻";
    const id = theme.fg("dim", `#${task.id}`);
    const blocked = blockers.length ? theme.fg("dim", ` › blocked by ${blockers.map((x) => `#${x}`).join(", ")}`) : "";
    if (isSpinning) {
      const elapsed = formatDuration(Date.now() - (this.activeSince.get(task.id) ?? Date.now()));
      return `  ${icon} ${id} ${theme.fg("accent", task.activeForm || task.title)} ${theme.fg("dim", `(${elapsed})`)}${blocked}`;
    }
    if (task.status === "completed") return `  ${icon} ${theme.fg("dim", theme.strikethrough(`#${task.id} ${task.title}`))}`;
    return `  ${icon} ${id} ${task.title}${blocked}`;
  }

  private ensureTimer(): void {
    if (!this.interval) this.interval = setInterval(() => this.update(), 120);
  }

  private stopTimer(): void {
    if (!this.interval || this.activeSince.size > 0) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }
}
