import { describe, expect, test } from "bun:test";
import { renderTaskManageResult, renderTaskNextResult } from "../src/ui/tool-render.js";
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
  test("renders completed task text dim while keeping the checkmark successful", () => {
    const rendered = renderTaskManageResult({
      content: [{ type: "text", text: "" }],
      details: {
        action: "list",
        operations: [],
        tasks: [task("1", "Done", "completed")],
      },
    }, {}, colorTheme as any);

    expect(textOf(rendered)).toBe(" <accent>●</accent> <accent>Tasks · 1/1 done</accent>\n  <success>✔</success> <dim>~#1 Done~</dim>");
  });

  test("renders task_manage affected tasks as a human event log", () => {
    const result = {
      content: [{ type: "text", text: "Created #1: Research" }],
      details: {
        action: "create",
        operations: [{ kind: "created", id: "1", title: "Research", warnings: [] }],
        tasks: [task("1", "Research", "pending")],
        guidance: "1 ready. Next: start ready #1 Research.",
      },
    };
    const rendered = renderTaskManageResult(result, {}, theme as any);
    const expanded = renderTaskManageResult(result, { expanded: true }, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks added\n  ◻ Added #1 Research");
    expect(textOf(expanded)).toBe(" ● Tasks added\n  ◻ Added #1 Research\n  ────────────\n  Current state\n  ◻ #1 Research\n  1 ready. Next: start ready #1 Research.");
  });

  test("renders dependency hints in task_manage event rows", () => {
    const blocker = task("1", "Blocker", "pending", { blocks: ["2"] });
    const blocked = task("2", "Blocked", "pending", { blockedBy: ["1"] });
    const rendered = renderTaskManageResult({
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
    const rendered = renderTaskManageResult({
      content: [{ type: "text", text: "Updated #1: status" }],
      details: {
        action: "update",
        operations: [{ kind: "updated", id: "1", title: "Research", changed: ["status"] }],
        tasks: [task("1", "Research", "in_progress")],
      },
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks updated\n  ◻ Updated #1 Research (status)");
  });

  test("renders done-archive operations with a completed icon", () => {
    const rendered = renderTaskManageResult({
      content: [{ type: "text", text: "Completed and archived #6" }],
      details: {
        action: "done_archive",
        operations: [{ kind: "done_archived", id: "6", title: "Verify" }],
        tasks: [],
      },
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks done archived\n  ✔ Done archived #6 Verify");
  });

  test("renders removed task operations with archive and purge symbols", () => {
    const archived = renderTaskManageResult({
      content: [{ type: "text", text: "Archived 1 task(s)" }],
      details: {
        action: "archive",
        operations: [{ kind: "archived", id: "6", title: "Demo" }],
        tasks: [],
      },
    }, {}, theme as any);

    const purged = renderTaskManageResult({
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

  test("renders unblocked task operations", () => {
    const rendered = renderTaskManageResult({
      content: [{ type: "text", text: "Completed #1\nUnblocked #2: Follow-up" }],
      details: {
        action: "complete",
        operations: [
          { kind: "completed", id: "1", title: "Blocker" },
          { kind: "unblocked", id: "2", title: "Follow-up" },
        ],
        tasks: [task("2", "Follow-up", "pending")],
      },
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tasks completed\n  ✔ Done #1 Blocker\n  ◻ Unblocked #2 Follow-up");
  });

  test("renders task_manage validation errors as tool output", () => {
    const rendered = renderTaskManageResult({
      isError: true,
      content: [{ type: "text", text: "Validation failed for tool \"task_manage\":\n  - action: must be equal to one of the allowed values\n\nReceived arguments:\n{\n  \"action\": \"updates\"\n}" }],
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tool error · task_manage\n  │ Validation failed for tool \"task_manage\":\n  │   - action: must be equal to one of the allowed values\n  │\n  │ Received arguments:\n  │ {\n  │   \"action\": \"updates\"\n  │ }");
  });

  test("renders task_next fallback errors as tool output even without isError", () => {
    const rendered = renderTaskNextResult({
      content: [{ type: "text", text: "Error: backend unavailable" }],
    }, {}, theme as any);

    expect(textOf(rendered)).toBe(" ● Tool error · task_next\n  │ Error: backend unavailable");
  });

  test("renders task_next as an actionable task snapshot", () => {
    const rendered = renderTaskNextResult({
      content: [{ type: "text", text: "Summary" }],
      details: {
        active: [task("1", "Implement", "in_progress")],
        ready: [task("2", "Verify", "pending")],
        blocked: [],
        completedCount: 3,
        totalCount: 5,
      },
    }, {}, theme as any);

    const text = textOf(rendered);
    expect(text).toBe(" ● Next tasks · 3/5 done · 1 active\n  ◼ #1 Implement\n  ◻ #2 Verify");
    expect(text).not.toContain("Active:");
    expect(text).not.toContain("Ready:");
  });
});
