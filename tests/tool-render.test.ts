import { describe, expect, test } from "bun:test";
import { renderTaskResult, renderTaskQueryResult } from "../src/ui/tool-render.js";
import type { DagTask } from "../src/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => text,
};

const colorTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  strikethrough: (text: string) => `~${text}~`,
};

function textOf(component: { render(width: number): string[] }): string {
  return component.render(120).map((line) => line.trimEnd()).join("\n");
}

function task(id: string, title: string, status: DagTask["status"], patch: Partial<DagTask> = {}): DagTask {
  return {
    id,
    title,
    description: "",
    status,
    blocks: [],
    blockedBy: [],
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

describe("task tool renderers", () => {
  test("renders task mutation event log for creates", () => {
    const result = {
      content: [{ type: "text", text: "Created #1: Research" }],
      details: {
        action: "create",
        operations: [{ kind: "created", id: "1", title: "Research", warnings: [] }],
        tasks: [task("1", "Research", "pending")],
        guidance: "1 ready. Next: start ready #1 Research.",
      },
    };
    const rendered = renderTaskResult(result, {}, theme as any);
    const expanded = renderTaskResult(result, { expanded: true }, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks added\n  ◻ Added #1 Research");
    expect(textOf(expanded)).toBe(" ● Tasks added\n  ◻ Added #1 Research\n  ────────────\n  Current state\n  ◻ #1 Research\n  1 ready. Next: start ready #1 Research.");
  });

  test("renders completed task text dim while keeping the checkmark successful", () => {
    const rendered = renderTaskQueryResult({
      content: [{ type: "text", text: "" }],
      details: {
        scope: "current",
        tasks: [task("1", "Done", "completed")],
      },
    }, { expanded: true }, colorTheme as any);

    expect(textOf(rendered)).toBe(" <accent>●</accent> <accent>Tasks · 1/1 done</accent>\n  <success>✔</success> <dim>~#1 Done~</dim>");
  });

  test("renders dependency hints in mutation event rows", () => {
    const blocker = task("1", "Blocker", "pending", { blocks: ["2"] });
    const blocked = task("2", "Blocked", "pending", { blockedBy: ["1"] });
    const rendered = renderTaskResult({
      content: [{ type: "text", text: "Created #2: Blocked" }],
      details: {
        action: "create",
        operations: [{ kind: "created", id: "2", title: "Blocked" }],
        tasks: [blocker, blocked],
      },
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks added\n  ◻ Added #2 Blocked ! blocked by #1");
  });

  test("renders updated task operations with an explicit verb", () => {
    const rendered = renderTaskResult({
      content: [{ type: "text", text: "Updated #1: status" }],
      details: {
        action: "update",
        operations: [{ kind: "updated", id: "1", title: "Research", changed: ["status"] }],
        tasks: [task("1", "Research", "in_progress")],
      },
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks updated\n  ◻ Updated #1 Research (status)");
  });

  test("renders archive_all and purge operations", () => {
    const archived = renderTaskResult({
      content: [{ type: "text", text: "Archived 1 task(s)" }],
      details: {
        action: "archive_all",
        operations: [{ kind: "archived", id: "6", title: "Demo" }],
        tasks: [],
      },
    }, {}, theme as any);

    const purged = renderTaskResult({
      content: [{ type: "text", text: "Purged 1/1 task(s)" }],
      details: {
        action: "purge",
        operations: [{ kind: "purged", id: "7", title: "Old" }],
        tasks: [],
      },
    }, {}, theme as any);

    expect(textOf(archived)).toBe(" ● Tasks archived\n  ◌ Archived #6 Demo");
    expect(textOf(purged)).toBe(" ● Tasks removed\n  − Removed #7 Old");
  });

  test("renders unblocked task operations after a completing update", () => {
    const rendered = renderTaskResult({
      content: [{ type: "text", text: "Updated #1: status\nUnblocked #2: Follow-up" }],
      details: {
        action: "update",
        operations: [
          { kind: "completed", id: "1", title: "Blocker" },
          { kind: "unblocked", id: "2", title: "Follow-up" },
        ],
        tasks: [task("2", "Follow-up", "pending")],
      },
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks updated\n  ✔ Done #1 Blocker\n  ◻ Unblocked #2 Follow-up");
  });

  test("renders task validation errors as tool output", () => {
    const rendered = renderTaskResult({
      content: [{ type: "text", text: "Validation failed for tool \"task\":\n  - action: must be equal to one of the allowed values\n\nReceived arguments:\n{\n  \"action\": \"updates\"\n}" }],
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tool error · task\n  │ Validation failed for tool \"task\":\n  │   - action: must be equal to one of the allowed values\n  │\n  │ Received arguments:\n  │ {\n  │   \"action\": \"updates\"\n  │ }");
  });

  test("renders task_query fallback errors as tool output even without isError", () => {
    const rendered = renderTaskQueryResult({
      content: [{ type: "text", text: "Error: backend unavailable" }],
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tool error · task_query\n  │ Error: backend unavailable");
  });

  test("renders task_query ready scope as an actionable task snapshot", () => {
    const rendered = renderTaskQueryResult({
      content: [{ type: "text", text: "Summary" }],
      details: {
        scope: "ready",
        inProgress: [task("1", "Implement", "in_progress")],
        ready: [task("2", "Verify", "pending")],
        blocked: [],
        completedCount: 3,
        totalCount: 5,
      },
    }, {}, theme as any);

    const text = textOf(rendered);
    expect(text).toBe(" ● Next tasks · 3/5 done · 1 in_progress\n  ◼ #1 Implement\n  ◻ #2 Verify");
  });
});
