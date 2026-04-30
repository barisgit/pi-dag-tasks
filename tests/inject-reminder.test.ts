import { describe, expect, test } from "bun:test";
import { injectReminder } from "../src/index.ts";

const reminder = "Task state: 1 open.";

function reminderText(message: any): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part: any) => part.text ?? part.content ?? "").join("\n");
}

describe("injectReminder", () => {
  test("does not append reminders to assistant tool-use messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "run help" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll run it." },
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "help" } },
        ],
      },
    ];

    const result = injectReminder(messages, reminder);

    expect(result[1].content).toEqual(messages[1].content);
    expect(result[1].content.at(-1).type).toBe("tool_use");
    expect(reminderText(result[0])).toContain("<task-reminder>");
  });

  test("appends reminders to internal tool result messages instead of the preceding assistant", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "run help" }] },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_1", name: "Bash", arguments: { command: "help" } }],
      },
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "Bash",
        isError: false,
        content: [{ type: "text", text: "usage" }],
      },
    ];

    const result = injectReminder(messages, reminder);

    expect(result[1].content).toEqual(messages[1].content);
    expect(reminderText(result[2])).toContain("<task-reminder>");
  });

  test("appends reminders as user text after Anthropic tool_result blocks", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "usage", is_error: false },
        ],
      },
    ];

    const result = injectReminder(messages, reminder);

    expect(result[0].content.map((part: any) => part.type)).toEqual(["tool_result", "text"]);
    expect(result[0].content[1].text).toContain("<task-reminder>");
  });

  test("does not synthesize a user turn when there is no user-side anchor", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "help" } }],
      },
    ];

    const result = injectReminder(messages, reminder);

    expect(result).toEqual(messages);
  });
});
