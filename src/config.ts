import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DagTasksConfig } from "./types.js";

export function configPath(cwd: string): string {
  return join(cwd, ".pi", "dag-tasks", "dag-tasks-config.json");
}

export function loadConfig(cwd: string): DagTasksConfig {
  try {
    return JSON.parse(readFileSync(configPath(cwd), "utf8")) as DagTasksConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: DagTasksConfig, cwd: string): void {
  const filePath = configPath(cwd);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(config, null, 2));
}
