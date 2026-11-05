import type { OpenCodeClient } from "@opencode/client/effect";
import type { ModelCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

export interface OpenCode2Agents {
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly mode: "primary" | "all" | "subagent";
    readonly hidden: boolean;
  }>;
  readonly defaultAgent?: string | undefined;
}

export const loadOpenCode2Agents = Effect.fn("loadOpenCode2Agents")(function* (
  client: OpenCodeClient,
  directory: string,
) {
  const location = { directory };
  const { agents, configs } = yield* Effect.all(
    {
      agents: client.agent.list({ location }).pipe(
        Effect.map((response) => response.data),
        Effect.repeat({
          until: (agents) => agents.length > 0,
          schedule: Schedule.spaced("250 millis"),
        }),
        Effect.timeout("5 seconds"),
      ),
      configs: client.config.get({ location }).pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => undefined),
      ),
    },
    { concurrency: "unbounded" },
  );
  let configured: string | undefined;
  for (const entry of configs ?? []) {
    if (entry.type === "document" && entry.info.default_agent !== undefined) {
      configured = entry.info.default_agent;
    }
  }
  const visible = agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const selected =
    configs === undefined
      ? undefined
      : visible.find((agent) =>
          configured === undefined ? agent.id === "build" : agent.id === configured,
        );
  return { agents: visible, defaultAgent: selected?.id } satisfies OpenCode2Agents;
});

export function withOpenCode2Agents(
  capabilities: ModelCapabilities | null,
  inventory: OpenCode2Agents,
): ModelCapabilities {
  const agents = inventory.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  return {
    ...capabilities,
    optionDescriptors: [
      ...(capabilities?.optionDescriptors ?? []).filter((option) => option.id !== "agent"),
      ...(agents.length === 0
        ? []
        : [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agents.map((agent) => ({
                id: agent.id,
                label: agent.name,
                ...(agent.id === inventory.defaultAgent ? { isDefault: true } : {}),
              })),
              ...(agents.some((agent) => agent.id === inventory.defaultAgent)
                ? { currentValue: inventory.defaultAgent }
                : {}),
            },
          ]),
    ],
  };
}
