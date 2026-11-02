import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL, CURSOR_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
    await expect.element(screen.getByText("Track usage in ChatGPT.")).toBeVisible();
    await expect.element(screen.getByText("Remaining allowance unavailable")).toBeVisible();
  });

  it("shows why Cursor remaining allowance is unavailable instead of inventing a percentage", async () => {
    const cursor: ServerProvider = {
      ...managedChatGpt("cursor", "Cursor Personal"),
      driver: ProviderDriverKind.make("cursor"),
      usageLimits: {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "unsupported",
          message:
            "This Cursor connection does not provide a dashboard token. Open Cursor usage with the account connected to this instance.",
        },
        externalUsage: { label: "Cursor usage", url: CURSOR_USAGE_URL },
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: [cursor] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("Cursor usage")).toBeVisible();
    await expect.element(screen.getByText("Cursor Personal on Desk")).toBeVisible();
    await expect.element(screen.getByText("Remaining allowance unavailable")).toBeVisible();
    await expect.element(screen.getByText(cursor.usageLimits!.unavailable!.message!)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Manage usage" })).toBeVisible();
    await expect.element(screen.getByText("100%", { exact: true })).not.toBeInTheDocument();
  });

  it("displays reported Cursor allowance as remaining percentage", async () => {
    const cursor: ServerProvider = {
      ...managedChatGpt("cursor", "Cursor Personal"),
      driver: ProviderDriverKind.make("cursor"),
      auth: { status: "authenticated", email: "cursor@example.test" },
      usageLimits: {
        checkedAt,
        windows: [{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 42 }],
      },
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: [cursor] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect.element(screen.getByText("58%", { exact: true }).first()).toBeVisible();
    await expect
      .element(screen.getByText("Remaining allowance unavailable"))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Manage usage" }))
      .not.toBeInTheDocument();
  });
});
