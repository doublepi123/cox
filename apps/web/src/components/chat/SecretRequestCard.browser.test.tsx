import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { SecretRequestItem } from "@t3tools/client-runtime/secret-request";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { SecretRequestCard } from "./SecretRequestCard";

import "~/index.css";

const haptics = vi.hoisted(() => ({ selection: vi.fn(() => true) }));
const sourceFixture = vi.hoisted(() => ({ enabled: false }));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: () => vi.fn().mockResolvedValue({ _tag: "Success" }),
}));

vi.mock(import("../../mobile/mobileShellBridge"), async (importOriginal) => ({
  ...(await importOriginal()),
  triggerMobileHapticSelection: haptics.selection,
}));

vi.mock(import("@t3tools/client-runtime/state/server"), async (importOriginal) => ({
  ...(await importOriginal()),
  hasFeatureFlag: (_config, flag) => flag === "secretProviders",
}));

vi.mock(import("@t3tools/client-runtime/secret-request"), async (importOriginal) => {
  const [actual, { SecretProviderId }] = await Promise.all([
    importOriginal(),
    import("@t3tools/contracts"),
  ]);
  return {
    ...actual,
    secretRequestSources: () =>
      sourceFixture.enabled
        ? [
            {
              id: SecretProviderId.make("test-provider"),
              label: "1Password",
              isReference: (reference: string) => reference.startsWith("op://"),
              referencePlaceholder: "op://vault/item/field",
              invalidReferenceMessage: "Use a 1Password reference.",
            },
          ]
        : [],
  };
});

async function mobileViewportScope() {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(390, 844);
  return {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
}

function visualViewportHeightScope(height: number) {
  const property = "--visual-viewport-height";
  const previous = document.documentElement.style.getPropertyValue(property);
  document.documentElement.style.setProperty(property, `${height}px`);
  return {
    [Symbol.dispose]() {
      if (previous) document.documentElement.style.setProperty(property, previous);
      else document.documentElement.style.removeProperty(property);
    },
  };
}

it("uses a native password input so masking also applies to assistive technologies", async () => {
  const item = {
    id: TurnItemId.make("secret-card-test"),
    threadId: ThreadId.make("secret-thread-test"),
    type: "secret_request",
    secretStatus: "pending",
    label: "API token",
    reason: "Configure the service",
  } as SecretRequestItem;
  await using screen = await render(
    <SecretRequestCard
      environmentId={EnvironmentId.make("local")}
      item={item}
      visibility="local"
    />,
  );
  const input = screen.container.querySelector("input");
  expect(input?.type).toBe("password");
  expect(input?.autocomplete).toBe("off");
  expect(input?.className).not.toContain("text-security");
  expect(input?.hasAttribute("data-1p-ignore")).toBe(true);
});

it("keeps secret inputs and actions touchable inside the shrunken visual viewport", async () => {
  await using _viewport = await mobileViewportScope();
  const item = {
    id: TurnItemId.make("secret-card-mobile"),
    threadId: ThreadId.make("secret-thread-mobile"),
    type: "secret_request",
    secretStatus: "pending",
    label: "API token",
    reason: "Configure the service with a credential supplied by your administrator. ".repeat(8),
  } as SecretRequestItem;
  await using screen = await render(
    <SecretRequestCard
      environmentId={EnvironmentId.make("local")}
      item={item}
      visibility="local"
    />,
  );
  using _visualHeight = visualViewportHeightScope(480);
  const form = screen.container.querySelector("form");
  if (!form) throw new Error("Missing secret request form");
  await expect.poll(() => getComputedStyle(form).maxHeight).toBe("336px");
  expect(getComputedStyle(form).overflowY).toBe("auto");
  expect(form.scrollHeight).toBeGreaterThan(form.clientHeight);
  for (const name of ["Save securely", "Decline"]) {
    const action = screen.getByRole("button", { name });
    expect(action.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  }
  const input = screen.getByLabelText("API token");
  expect(input.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

it("emits mobile haptic selection for source, submit, and decline actions", async () => {
  haptics.selection.mockClear();
  sourceFixture.enabled = true;
  using _sources = {
    [Symbol.dispose]() {
      sourceFixture.enabled = false;
    },
  };
  const item = {
    id: TurnItemId.make("secret-card-haptics"),
    threadId: ThreadId.make("secret-thread-haptics"),
    type: "secret_request",
    secretStatus: "pending",
    label: "API token",
    reason: "Configure the service",
  } as SecretRequestItem;
  await using screen = await render(
    <SecretRequestCard
      environmentId={EnvironmentId.make("local")}
      item={item}
      visibility="local"
    />,
  );

  await userEvent.click(screen.getByRole("combobox", { name: "API token source" }));
  await userEvent.click(page.getByRole("option", { name: "1Password" }));
  expect(haptics.selection).toHaveBeenCalledTimes(1);

  await userEvent.fill(screen.getByLabelText("API token"), "op://vault/item/field");
  await userEvent.click(screen.getByRole("button", { name: "Save securely" }));
  expect(haptics.selection).toHaveBeenCalledTimes(2);

  await userEvent.click(screen.getByRole("button", { name: "Decline" }));
  expect(haptics.selection).toHaveBeenCalledTimes(3);
});

it("shows a named public field and lets users reveal and re-mask each secret", async () => {
  const item: SecretRequestItem = {
    id: TurnItemId.make("secret-multi-field"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "running",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-22T00:00:00Z"),
    threadId: ThreadId.make("secret-multi-field-thread"),
    type: "secret_request",
    secretStatus: "pending",
    label: "Staging login",
    reason: "Configure the service",
    delivery: "file",
    fields: [
      { name: "email", label: "Email", secret: false },
      { name: "password", label: "Password" },
    ],
  };
  await using screen = await render(
    <SecretRequestCard
      environmentId={EnvironmentId.make("local")}
      item={item}
      visibility="local"
    />,
  );
  const email = screen.getByLabelText("Email", { exact: true });
  const password = screen.getByLabelText("Password", { exact: true });
  const toggle = screen.getByRole("button", { name: "Show Password" });
  const save = screen.getByRole("button", { name: "Save securely" });
  await expect.element(email).toHaveAttribute("type", "text");
  await expect.element(password).toHaveAttribute("type", "password");
  await expect.element(save).toBeDisabled();
  await userEvent.fill(email, "qa@example.test");
  await expect.element(save).toBeDisabled();
  await userEvent.fill(password, "fixture-password");
  await expect.element(save).toBeEnabled();
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.element(password).toHaveAttribute("type", "text");
  await userEvent.click(toggle);
  await expect.element(password).toHaveAttribute("type", "password");
});
