import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { resolveComposerDispatchMode } from "@t3tools/client-runtime/state/composer-dispatch";
import { PaperclipIcon } from "lucide-react";
import { type ComponentProps, useRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const persistence = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
}));

vi.mock("~/localApi", () => ({ ensureLocalApi: () => ({ persistence }) }));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentificationMode: () => "none",
}));

import { act, render } from "../../../test/render";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { LANGUAGE_STORAGE_KEY, setLanguagePreference, type Language } from "../../i18n";
import { parseLanguagePreference } from "../../i18n/language";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerControlsBar } from "./ComposerControlsBar";
import { ComposerFollowUpBehavior } from "./ComposerFollowUpBehavior";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ContextWindowMeterPlaceholder } from "./ContextWindowMeter";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";
import { runtimeModeConfig } from "./runtimeModeConfig";

const environmentId = EnvironmentId.make("follow-up-test");
const instanceId = ProviderInstanceId.make("codex-service");
const threadId = ThreadId.make("follow-up-thread");
const driver = ProviderDriverKind.make("codex");
const models = [
  {
    slug: "gpt-6.1-sol",
    name: "gpt-6.1-sol",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: [{ id: "ultra", label: "ultra", isDefault: true }],
        },
      ],
    },
  },
];
const entries = deriveProviderInstanceEntries([
  {
    instanceId,
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-04T10:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  },
]);
const controls = {
  environmentId,
  routeKind: "server",
  routeThreadRef: { environmentId, threadId },
  draftId: null,
  selectedProvider: driver,
  selectedInstanceId: instanceId,
  selectedModel: "gpt-6.1-sol",
  selectedProviderModels: models,
  composerModelOptions: null,
  reportedModelSelection: null,
  promptUltrathink: "none",
  onPromptEdit: () => {},
  planModeEnabled: false,
  planModeUiEnabled: false,
  effortDisplay: "label",
  permissionsShownInStrip: false,
  interactionMode: "default",
  compatibleRuntimeMode: "full-access",
  defaultRuntimeMode: "full-access",
  compatibleRuntimeModeOptions: [{ mode: "full-access", ...runtimeModeConfig["full-access"] }],
  toggleInteractionMode: () => {},
  handleRuntimeModeChange: () => {},
  composerControlsCollapsed: false,
  composerControlsHidden: false,
  restingHiddenBlockCount: 0,
  iconOnlyBlockCount: 0,
  showProviderUnavailable: false,
  providerSetupInstanceId: undefined,
  onOpenProviderSetup: () => {},
  providerCatalogPending: false,
  isSendBusy: false,
  multipleModelsEnabled: false,
  multipleModelSelections: null,
  onMultipleModelSelectionsChange: () => {},
  selectedModelSelection: { instanceId, model: "gpt-6.1-sol" },
  onProviderModelSelect: () => {},
  activeThreadModelSelection: { instanceId, model: "gpt-6.1-sol" },
  selectedModelForPickerWithCustomFallback: "gpt-6.1-sol",
  lockedProvider: null,
  lockedContinuationGroupKey: null,
  providerInstanceEntries: entries,
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
  modelOptionsByInstance: new Map([[instanceId, models]]),
  terminalOpen: false,
  modelPickerOpen: false,
  onModelPickerOpenChange: () => {},
  modelPickerIconClassName: undefined,
  getModelDisabledReason: () => null,
} satisfies ComponentProps<typeof ComposerControlsBar>;

function setupPreferences(): AsyncDisposable {
  const originalLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  setLanguagePreference("en");
  __resetClientSettingsPersistenceForTests();
  persistence.getClientSettings.mockReset().mockResolvedValue(null);
  persistence.setClientSettings.mockReset().mockResolvedValue(undefined);
  return {
    async [Symbol.asyncDispose]() {
      __resetClientSettingsPersistenceForTests();
      setLanguagePreference(parseLanguagePreference(originalLanguage));
      if (originalLanguage === null) localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      await page.viewport(originalViewport.width, originalViewport.height);
    },
  };
}

function Footer({
  running = true,
  collapsed = false,
  onDispatch,
}: {
  running?: boolean;
  collapsed?: boolean;
  onDispatch: (mode: string) => void;
}) {
  const behavior = useClientSettings((settings) => settings.followUpBehavior);
  const controlsRef = useRef<HTMLDivElement>(null);
  return (
    <form
      data-testid="footer"
      className="flex w-full min-w-0 items-center gap-2 px-2"
      onSubmit={(event) => {
        event.preventDefault();
        onDispatch(
          resolveComposerDispatchMode({
            running,
            activeTurnDefault: behavior,
            alternateModifier: false,
          }),
        );
      }}
    >
      <button
        type="button"
        aria-label="Attach files"
        className="flex size-9 shrink-0 items-center justify-center"
      >
        <PaperclipIcon className="size-5" />
      </button>
      <div
        ref={controlsRef}
        data-testid="controls"
        className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5"
      >
        <ComposerControlsBar {...controls} composerControlsCollapsed={collapsed} />
      </div>
      <ContextWindowMeterPlaceholder />
      <ComposerPrimaryActions
        compact
        canOperateThread
        pendingAction={null}
        isRunning={running}
        canInterrupt={false}
        followUpBehavior={behavior}
        showPlanFollowUpPrompt={false}
        promptHasText
        isSendBusy={false}
        sendDisabledReason={null}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent
        onDispatchMessage={onDispatch}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />
    </form>
  );
}

describe("composer follow-up preference", () => {
  it("loads the saved preference, persists changes and updates sending without dispatching on selection", async () => {
    await using _preferences = setupPreferences();
    persistence.getClientSettings.mockResolvedValue({
      ...DEFAULT_CLIENT_SETTINGS,
      followUpBehavior: "steer",
      timestampFormat: "12-hour",
    });
    const onDispatch = vi.fn();
    await using screen = await render(<Footer onDispatch={onDispatch} />);
    await screen.getByRole("button", { name: "Follow-up behavior: Steer" }).click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "Steer", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitemradio", { name: "Queue", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Follow-up behavior: Queue" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Queue message", exact: true }))
      .toBeVisible();
    await vi.waitFor(() =>
      expect(persistence.setClientSettings).toHaveBeenCalledWith(
        expect.objectContaining({ followUpBehavior: "queue", timestampFormat: "12-hour" }),
      ),
    );
    expect(onDispatch).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Queue message", exact: true }).click();
    expect(onDispatch).toHaveBeenCalledExactlyOnceWith("queue");
    await act(() => updateClientSettings({ followUpBehavior: "steer" }));
    await expect
      .element(screen.getByRole("button", { name: "Follow-up behavior: Steer" }))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Steer message" })).toBeVisible();
    await screen.getByRole("button", { name: "Message send options" }).click();
    await page.getByRole("menuitem", { name: "Queue message", exact: true }).click();
    expect(getClientSettings().followUpBehavior).toBe("steer");
    expect(onDispatch).toHaveBeenLastCalledWith("queue");
    await screen.rerender(<Footer running={false} onDispatch={onDispatch} />);
    await screen.getByRole("button", { name: "Submit message" }).click();
    expect(onDispatch).toHaveBeenLastCalledWith("auto");
  });

  it("supports keyboard selection and Escape without changing the saved preference", async () => {
    await using _preferences = setupPreferences();
    await using screen = await render(<ComposerFollowUpBehavior />, { router: false });
    await ensureClientSettingsHydrated();
    await userEvent.tab();
    await userEvent.keyboard("{ArrowDown}");
    await expect
      .element(page.getByRole("menuitemradio", { name: "Queue", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    const trigger = screen.getByRole("button", { name: "Follow-up behavior: Steer" });
    await expect.element(trigger).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{Escape}");
    await expect.element(trigger).toHaveFocus();
    expect(getClientSettings().followUpBehavior).toBe("steer");
    expect(persistence.setClientSettings).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the composer after a pick and closes when its host hides", async () => {
    await using _preferences = setupPreferences();
    const focusAtEnd = vi.fn();
    const handle = { current: { focusAtEnd } } as unknown as ComposerHandleRef;
    await using screen = await render(
      <ComposerHandleContext value={handle}>
        <ComposerFollowUpBehavior />
      </ComposerHandleContext>,
      { router: false },
    );
    await screen.getByRole("button", { name: "Follow-up behavior: Queue" }).click();
    await page.getByRole("menuitemradio", { name: "Steer", exact: true }).click();
    await vi.waitFor(() => expect(focusAtEnd).toHaveBeenCalled());
    await screen.getByRole("button", { name: "Follow-up behavior: Steer" }).click();
    await screen.rerender(
      <ComposerHandleContext value={handle}>
        <ComposerFollowUpBehavior hidden />
      </ComposerHandleContext>,
    );
    await expect
      .element(page.getByRole("menuitemradio", { name: "Queue", exact: true }))
      .not.toBeInTheDocument();
  });

  it.each([
    { width: 320, language: "zh", collapsed: false },
    { width: 390, language: "en", collapsed: false },
    { width: 430, language: "zh", collapsed: false },
    { width: 1024, language: "en", collapsed: false },
    { width: 320, language: "en", collapsed: true },
  ] satisfies ReadonlyArray<{ width: number; language: Language; collapsed: boolean }>)(
    "fits the real model and send controls at $width px ($language, collapsed: $collapsed)",
    async ({ width, language, collapsed }) => {
      await using _preferences = setupPreferences();
      await page.viewport(width, 740);
      setLanguagePreference(language);
      await using screen = await render(<Footer collapsed={collapsed} onDispatch={() => {}} />);
      const name = language === "zh" ? "后续消息行为：排队" : "Follow-up behavior: Queue";
      const trigger = screen.getByRole("button", { name });
      await expect.element(trigger).toBeVisible();
      const footer = screen.getByTestId("footer").element();
      expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth);
      const model = screen.container.querySelector<HTMLElement>(
        "[data-chat-provider-model-picker]",
      )!;
      expect(model.getBoundingClientRect().right).toBeLessThanOrEqual(
        trigger.element().getBoundingClientRect().left,
      );
      if (width < 640 && !collapsed)
        expect(trigger.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      const controlHost = screen.getByTestId("controls").element() as HTMLElement;
      const measurement = measureRestingComposerControls(controlHost)!;
      const fixed = controlHost.querySelector<HTMLElement>("[data-composer-fixed-control]")!;
      expect(measurement.minimumFixedWidth).toBeCloseTo(
        Number.parseFloat(getComputedStyle(model).minWidth) +
          fixed.getBoundingClientRect().width +
          Number.parseFloat(getComputedStyle(controlHost).columnGap),
        4,
      );
      await trigger.click();
      const choice = page.getByRole("menuitemradio", {
        name: language === "zh" ? "引导" : "Steer",
        exact: true,
      });
      const bounds = choice.element().getBoundingClientRect();
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.left).toBeGreaterThanOrEqual(0);
      expect(bounds.right).toBeLessThanOrEqual(width);
      await choice.click();
      await expect
        .element(
          screen.getByRole("button", {
            name: language === "zh" ? "后续消息行为：引导" : "Follow-up behavior: Steer",
          }),
        )
        .toBeVisible();
      expect(footer.scrollWidth).toBeLessThanOrEqual(footer.clientWidth);
    },
  );
});
