import {
  CodexSettings,
  ClaudeSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";
import type { ComponentProps, ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { ContextWindowMeter } from "../chat/ContextWindowMeter";
import { CustomModelEditor } from "./CustomModelEditor";
import type { ContextWindowSnapshot } from "../../lib/contextWindow";
import { ScrollToEndButton, WorkspaceFileDropOverlay } from "../chat/TimelineOverlays";
import { NotificationSettings } from "./NotificationSettings";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";
import { ProviderEnvironmentSection, ProviderInstanceCard } from "./ProviderInstanceCard";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { SnoozePresetsRow } from "./SnoozePresetsSettings";
import { ThemeEditorPanel } from "./ThemeEditorPanel";

vi.mock("./useScopedSettings", async (original) => ({
  ...(await original<typeof import("./useScopedSettings")>()),
  useScopedSettings: <Result,>(selector?: (settings: UnifiedSettings) => Result) => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, notificationMode: "off" as const };
    return selector ? selector(settings) : settings;
  },
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
}));

vi.mock("./settingsLayout", async (original) => ({
  ...(await original<typeof import("./settingsLayout")>()),
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingResetButton: () => null,
  SettingsRow: ({
    title,
    description,
    status,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    status?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
      <div>{status}</div>
      {control}
      {children}
    </div>
  ),
}));

vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({
    error: null,
    data: {
      phase: "idle",
      methods: [
        { id: "chatgpt", name: "ChatGPT" },
        { id: "api", name: "API key" },
      ],
    },
  }),
}));

vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: () => vi.fn(),
}));

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.156.1",
  status: "ready",
  auth: {
    status: "authenticated",
    label: "ChatGPT",
    email: "original@example.test",
    canLogout: true,
  },
  checkedAt: "2026-11-02T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

function chineseLanguage() {
  setLanguagePreference("zh");
  return { [Symbol.dispose]: () => setLanguagePreference("system") };
}

it("localizes snooze duration previews and selected units without changing their values", async () => {
  using _language = chineseLanguage();
  await using screen = await render(<SnoozePresetsRow />, { router: false });
  await expect.element(screen.getByText("1 小时后", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("combobox", { name: "单位" }).first())
    .toHaveTextContent("小时");
  await act(() => setLanguagePreference("en"));
  await expect.element(screen.getByText("In 1 hour", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("combobox", { name: "Unit" }).first())
    .toHaveTextContent("hour");
});

it("keeps theme appearance values usable while switching localized labels", async () => {
  using _language = chineseLanguage();
  await using screen = await render(
    <ThemeEditorPanel
      open
      onOpenChange={vi.fn()}
      onSaved={vi.fn()}
      editingTheme={null}
      initialAppearance="light"
      restoreTheme={vi.fn()}
    />,
    { router: false },
  );
  const dark = screen.getByRole("button", { name: "深色", exact: true });
  await dark.click();
  await expect.element(dark).toHaveAttribute("aria-pressed", "true");
  await act(() => setLanguagePreference("en"));
  await expect
    .element(screen.getByRole("button", { name: "Dark", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});

for (const [driverKind, settingsSchema] of [
  [ProviderDriverKind.make("codex"), CodexSettings],
  [ProviderDriverKind.make("claudeAgent"), ClaudeSettings],
] as const) {
  for (const variant of ["settings", "card", "dialog"] as const) {
    it(`localizes ${driverKind} gateway fields in the ${variant} form and switches live`, async () => {
      using _language = chineseLanguage();
      const gatewayUrl = "https://gateway.example.test/v1";
      await using screen = await render(
        <ProviderSettingsForm
          definition={{ driverKind, settingsSchema }}
          fieldKeys={["baseUrl", "apiKey"]}
          idPrefix="gateway-localization"
          value={{ baseUrl: gatewayUrl }}
          variant={variant}
          onChange={vi.fn()}
        />,
        { router: false },
      );
      await expect.element(screen.getByText("API 地址", { exact: true })).toBeVisible();
      await expect.element(screen.getByText("API 密钥", { exact: true })).toBeVisible();
      await expect
        .element(
          screen.getByText("可选的网关 API 基础地址；留空使用提供商默认地址。", { exact: true }),
        )
        .toBeVisible();
      await expect
        .element(
          screen.getByText("密钥单独安全保存在本机；API 费用与订阅额度独立计算。", { exact: true }),
        )
        .toBeVisible();
      await expect.element(screen.getByPlaceholder("未设置", { exact: true })).toBeVisible();
      await expect
        .element(screen.getByPlaceholder("https://gateway.example.com/v1"))
        .toHaveValue(gatewayUrl);
      await act(() => setLanguagePreference("en"));
      await expect.element(screen.getByText("API URL", { exact: true })).toBeVisible();
      await expect
        .element(
          screen.getByText(
            "Optional gateway API base URL. Leave empty to use the provider's default.",
            { exact: true },
          ),
        )
        .toBeVisible();
      await expect.element(screen.getByPlaceholder("Not set", { exact: true })).toBeVisible();
      await expect
        .element(screen.getByPlaceholder("https://gateway.example.com/v1"))
        .toHaveValue(gatewayUrl);
    });
  }
}

it("localizes the saved gateway secret placeholder and clear action without exposing the secret", async () => {
  using _language = chineseLanguage();
  const onChange = vi.fn();
  await using screen = await render(
    <ProviderSettingsForm
      definition={{ driverKind: ProviderDriverKind.make("codex"), settingsSchema: CodexSettings }}
      fieldKeys={["apiKey"]}
      idPrefix="saved-gateway-secret"
      value={{ apiKey: "__stored_secret__" }}
      variant="settings"
      onChange={onChange}
    />,
    { router: false },
  );
  await expect.element(screen.getByPlaceholder("已保存密钥，输入新值以替换")).toHaveValue("");
  await screen.getByRole("button", { name: "清除API 密钥" }).click();
  expect(onChange).toHaveBeenCalledWith(undefined);
});

function ProviderRow({
  liveProvider = provider,
  mode = "list",
}: {
  liveProvider?: ServerProvider;
  mode?: "list" | "editor";
}) {
  const props: ComponentProps<typeof ProviderInstanceCard> = {
    instanceId: provider.instanceId,
    instance: { driver: provider.driver, displayName: "My Codex", enabled: liveProvider.enabled },
    driverOption: undefined,
    liveProvider,
    mode,
    onUpdate: vi.fn(),
    hiddenModels: [],
    favoriteModels: [],
    modelOrder: [],
    onHiddenModelsChange: vi.fn(),
    onFavoriteModelsChange: vi.fn(),
    onToggleFavorite: vi.fn(),
    onModelOrderChange: vi.fn(),
  };
  return <ProviderInstanceCard {...props} />;
}

it("localizes scroll and file-drop controls without translating dynamic summaries", async () => {
  using _language = chineseLanguage();
  const scroll = vi.fn();
  await using screen = await render(
    <>
      <ScrollToEndButton bottom={10} summary="My custom summary" onScrollToEnd={scroll} />
      <WorkspaceFileDropOverlay />
    </>,
    { router: false },
  );
  await screen.getByRole("button", { name: /滚动到底部.*My custom summary/ }).click();
  expect(scroll).toHaveBeenCalledOnce();
  await expect.element(screen.getByText("拖放文件以添加附件")).toBeVisible();
});

it("localizes context window controls and automatic compaction explanations", async () => {
  using _language = chineseLanguage();
  const usage: ContextWindowSnapshot = {
    usedTokens: 111000,
    maxTokens: 258000,
    remainingTokens: 147000,
    usedPercentage: 43,
    remainingPercentage: 57,
    updatedAt: "2026-11-02T00:00:00Z",
    compactsAutomatically: true,
  };
  await using screen = await render(
    <ContextWindowMeter
      usage={usage}
      modelDisplayName="GPT-6.1-Sol"
      onCompact={vi.fn()}
      compactDisabled
      compactDisabledReason="Compacting is unavailable right now"
    />,
    { router: false },
  );
  await screen.getByRole("button", { name: "上下文窗口已使用 43%" }).click();
  await expect.element(screen.getByText("上下文窗口", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("GPT-6.1-Sol 的上下文会在需要时自动压缩。")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "压缩上下文" })).toBeDisabled();
  await expect.element(screen.getByText("当前无法压缩上下文")).toBeVisible();
});

it("prefills reported model context and image support in the localized editor", async () => {
  using _language = chineseLanguage();
  const save = vi.fn();
  await using screen = await render(
    <CustomModelEditor
      instanceId="gateway"
      driverKind={ProviderDriverKind.make("codex")}
      entry={{
        slug: "gateway-model",
        name: "gateway-model",
        capabilities: { contextWindow: 128000, supportsImages: false },
      }}
      builtInModels={[]}
      onSave={save}
      onCancel={vi.fn()}
    />,
    { router: false },
  );
  await expect.element(screen.getByLabelText("上下文窗口（令牌数）")).toHaveValue("128000");
  await expect
    .element(screen.getByRole("combobox", { name: "图片输入（多模态）" }))
    .toHaveTextContent("不支持");
  await screen.getByLabelText("上下文窗口（令牌数）").fill("256000");
  await screen.getByRole("button", { name: "保存", exact: true }).click();
  expect(save).toHaveBeenCalledWith({
    slug: "gateway-model",
    name: "gateway-model",
    capabilities: { contextWindow: 256000, supportsImages: false },
  });
});

it("localizes the notification description, selected value and all dropdown options", async () => {
  using _language = chineseLanguage();
  await using screen = await render(<NotificationSettings />, { router: false });
  await expect
    .element(
      screen.getByText(
        "对话完成、失败或需要输入与批准时发送系统通知。仅在 Cox 打开时对当前设备生效。",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByText("关闭", { exact: true })).toBeVisible();
  await screen.getByRole("combobox", { name: "对话通知" }).click();
  for (const name of ["关闭", "仅通知", "仅声音", "通知和声音"]) {
    await expect.element(page.getByRole("option", { name, exact: true })).toBeVisible();
  }
});

it("uses the current language for provider status and reacts to language changes", async () => {
  using _language = chineseLanguage();
  await using screen = await render(<ProviderRow />, { router: false });
  await expect.element(screen.getByText("已认证 · ChatGPT", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("My Codex", { exact: true })).toBeVisible();
  await act(() => setLanguagePreference("en"));
  await expect.element(screen.getByText("Authenticated · ChatGPT", { exact: true })).toBeVisible();
  await act(() => setLanguagePreference("zh"));
  await screen.rerender(<ProviderRow liveProvider={{ ...provider, enabled: false }} />);
  await expect.element(screen.getByText("已禁用", { exact: true })).toBeVisible();
});

it("localizes account actions, default method and the add-variable control", async () => {
  using _language = chineseLanguage();
  await using screen = await render(
    <>
      <ProviderAuthenticationSection
        environmentId={EnvironmentId.make("local")}
        environmentLabel="My computer"
        instanceId={provider.instanceId}
        provider={provider}
        readOnly={false}
      />
      <ProviderEnvironmentSection environment={[]} onChange={vi.fn()} />
    </>,
    { router: false },
  );
  await expect.element(screen.getByRole("button", { name: "切换账号", exact: true })).toBeVisible();
  await expect.element(screen.getByText("提供商默认值", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "添加变量", exact: true })).toBeVisible();
});

it("localizes the provider editor authentication prefix without changing brand names", async () => {
  using _language = chineseLanguage();
  await using screen = await render(<ProviderRow mode="editor" />, { router: false });
  await expect.element(screen.getByText("已认证为", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("· ChatGPT", { exact: true })).toBeVisible();
});
