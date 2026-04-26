import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DagTasksConfig } from "./types.js";

export const CONFIG_PATH = join(process.cwd(), ".pi", "dag-tasks", "dag-tasks-config.json");

export function loadConfig(): DagTasksConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DagTasksConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: DagTasksConfig): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
