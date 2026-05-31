import { describe, expect, test } from "bun:test";
import { DagTaskStore } from "../src/store.js";
import { DagTaskWidget } from "../src/ui/widget.js";

const theme = {
  fg: (_color: string, text: string) => text,
  strikethrough: (text: string) => text,
};

const colorTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  strikethrough: (text: string) => `~${text}~`,
};

function render(widget: DagTaskWidget, columns = 120, themeOverride = theme): string[] {
  return (widget as any).render({ terminal: { columns } }, themeOverride);
}

describe("DagTaskWidget", () => {
  test("uses compact progress header without leading status dot", () => {
    const store = new DagTaskStore();
    store.create({ title: "Done", status: "completed" });
    store.create({ title: "Active", status: "in_progress" });
    const widget = new DagTaskWidget(store);

    expect(render(widget)[0]).toBe(" Tasks · 1/2 done · 1 active");
  });

  test("renders completed task text dim while keeping the checkmark successful", () => {
    const store = new DagTaskStore();
    store.create({ title: "Done", status: "completed" });
    const widget = new DagTaskWidget(store);

    expect(render(widget, 120, colorTheme)).toContain("  <success>✔</success> <dim>~#1 Done~</dim>");
  });

  test("compact mode keeps recent completed rows in place and summarizes omitted open rows", () => {
    const store = new DagTaskStore();
    for (let i = 1; i <= 3; i++) store.create({ title: `Done ${i}`, status: "completed" });
    store.create({ title: "Active", status: "in_progress" });
    for (let i = 1; i <= 9; i++) store.create({ title: `Ready ${i}` });
    const widget = new DagTaskWidget(store);

    const lines = render(widget);
    expect(lines[0]).toBe(" Tasks · 3/13 done · 1 active");
    expect(lines.join("\n")).not.toContain("Done 1");
    expect(lines.join("\n")).toContain("#2 Done 2");
    expect(lines.join("\n")).toContain("#3 Done 3");
    expect(lines.findIndex((line) => line.includes("#2 Done 2"))).toBeLessThan(lines.findIndex((line) => line.includes("#4 Active")));
    expect(lines).toContain("  +5 open");
    expect(lines.join("\n")).toContain("#4 Active");
    expect(lines.join("\n")).toContain("#8 Ready 4");
    expect(lines.join("\n")).not.toContain("#9 Ready 5");
  });

  test("blocked rows use a distinct icon and dim blocked-by marker", () => {
    const store = new DagTaskStore();
    const blocker = store.create({ title: "Blocker" }).task;
    store.create({ title: "Blocked task", blockedBy: [blocker.id] });
    const widget = new DagTaskWidget(store);

    expect(render(widget)).toContain("  ◫ #2 Blocked task › blocked by #1");
  });
});
