#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_DSH_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
if (process.argv.includes("--version")) {
  process.stdout.write("0.2.2-rc.5\n");
  process.exit(0);
}
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const models =
  process.env.FAKE_DSH_MODELS === "none"
    ? []
    : [
        {
          value: JSON.stringify(["deepseek-official", "deepseek-flash"]),
          name: "DeepSeek-V4.1-Flash",
        },
        {
          value: JSON.stringify(["deepseek-official", "deepseek-v4-pro"]),
          name: "DeepSeek-V4-Pro",
        },
      ];
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({
        id: request.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { fork: {}, list: {} } },
          authMethods: [],
        },
      });
    } else if (request.method === "session/new") {
      send({
        id: request.id,
        result: {
          sessionId: "fake-session",
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "plan", name: "Plan" },
            ],
          },
          configOptions: [
            ...(models.length === 0
              ? []
              : [
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: models[0].value,
                    options: [{ group: "deepseek-official", name: "DeepSeek", options: models }],
                  },
                ]),
            {
              id: "reasoning_effort",
              name: "Reasoning effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "off", name: "Off" },
                { value: "high", name: "High" },
              ],
            },
          ],
        },
      });
      send({
        method: "session/update",
        params: {
          sessionId: "fake-session",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "plan",
                description: "Enter or leave plan mode",
                input: { hint: "[off|message]" },
              },
              { name: "compact", description: "Compact older conversation history" },
            ],
          },
        },
      });
    } else if (request.id !== undefined) {
      send({ id: request.id, result: {} });
    }
  }
});
