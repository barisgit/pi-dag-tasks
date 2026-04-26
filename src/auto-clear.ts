import type { DagTaskStore } from "./store.js";

export type AutoArchiveMode = "never" | "on_list_complete" | "on_task_complete";

export class AutoArchiveManager {
  private completedAtTurn = new Map<string, number>();
  private allCompletedAtTurn: number | null = null;

  constructor(private getStore: () => DagTaskStore, private getMode: () => AutoArchiveMode, private delayTurns = 4) {}

  trackCompletion(taskId: string, currentTurn: number): void {
    const mode = this.getMode();
    if (mode === "never") return;
    if (mode === "on_task_complete") this.completedAtTurn.set(taskId, currentTurn);
    if (mode === "on_list_complete") this.checkAllCompleted(currentTurn);
  }

  resetBatchCountdown(): void {
    this.allCompletedAtTurn = null;
  }

  reset(): void {
    this.completedAtTurn.clear();
    this.allCompletedAtTurn = null;
  }

  onTurnStart(currentTurn: number): boolean {
    const mode = this.getMode();
    if (mode === "never") return false;
    let archived = false;
    const store = this.getStore();
    if (mode === "on_task_complete") {
      for (const [id, turn] of this.completedAtTurn) {
        const task = store.get(id);
        if (!task || task.status !== "completed") this.completedAtTurn.delete(id);
        else if (currentTurn - turn >= this.delayTurns) {
          store.archive([id]);
          this.completedAtTurn.delete(id);
          archived = true;
        }
      }
    } else if (this.allCompletedAtTurn !== null && currentTurn - this.allCompletedAtTurn >= this.delayTurns) {
      store.archiveCompleted();
      this.allCompletedAtTurn = null;
      archived = true;
    }
    return archived;
  }

  private checkAllCompleted(currentTurn: number): void {
    const tasks = this.getStore().list();
    this.allCompletedAtTurn = tasks.length > 0 && tasks.every((task) => task.status === "completed")
      ? this.allCompletedAtTurn ?? currentTurn
      : null;
  }
}
