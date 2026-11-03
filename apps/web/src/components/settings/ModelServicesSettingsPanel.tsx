import {
  ModelServiceConfig,
  ModelServiceId,
  type EnvironmentId,
  type ModelServiceModel,
  type ModelServiceProtocol,
  type ServerSettings,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { modelServiceDisplayName } from "@t3tools/shared/modelServices";
import * as Schema from "effect/Schema";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useTranslation } from "../../i18n";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

export const MODEL_SERVICE_PROTOCOL_LABELS: Record<ModelServiceProtocol, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
  gemini: "Gemini",
};
const protocols = Object.keys(MODEL_SERVICE_PROTOCOL_LABELS) as ModelServiceProtocol[];
const decodeService = Schema.decodeUnknownSync(ModelServiceConfig);

function commandError(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  if (isAtomCommandInterrupted(result))
    return "The operation was interrupted. Retry to confirm its result.";
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "The model service operation failed.";
}

export function ModelServicesSettingsPanel() {
  const { t } = useTranslation();
  const { environment, scope } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <EnvironmentModelServices
          key={environment.environmentId}
          environmentId={environment.environmentId}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
        />
      ) : (
        <SettingsSection title={t("Model services")}>
          <SettingsRow title={t("Connect to Cox to manage model services.")} />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

export function EnvironmentModelServices({
  environmentId,
  projectScoped = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectScoped?: boolean;
}) {
  const { t } = useTranslation();
  const settings = useEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, "providers:manage");
  const readOnly = !canManage || projectScoped;
  const [editing, setEditing] = useState<ModelServiceId | null>(null);
  const services = settings.modelServices;
  const entries = Object.entries(services) as Array<[ModelServiceId, ModelServiceConfig]>;
  const first = entries[0]?.[0];
  const selected = editing ?? first;
  return (
    <SettingsSection
      title={t("Model services")}
      id="model-services"
      headerAction={
        !readOnly ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditing(ModelServiceId.make(`service_${randomUUID()}`))}
          >
            {t("Add model service")}
          </Button>
        ) : undefined
      }
    >
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        {t(
          "Configure an API once, discover its models, and share it with compatible coding agents.",
        )}
      </p>
      {projectScoped ? (
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {t("Environment-wide setting. Select an environment to change it.")}
        </p>
      ) : null}
      {entries.length ? (
        <div className="flex flex-wrap gap-2 px-3 sm:px-4">
          {entries.map(([id, service]) => (
            <Button
              key={id}
              size="sm"
              variant={selected === id ? "secondary" : "outline"}
              onClick={() => setEditing(id)}
            >
              {service.name}
            </Button>
          ))}
        </div>
      ) : !selected ? (
        <SettingsRow
          title={t("No model services configured.")}
          description={t("Add a service with its API URL, API key and supported protocols.")}
        />
      ) : null}
      {selected ? (
        <ModelServiceEditor
          key={selected}
          id={selected}
          service={services[selected]}
          environmentId={environmentId}
          settings={settings}
          readOnly={readOnly}
          onDeleted={() => setEditing(null)}
        />
      ) : null}
    </SettingsSection>
  );
}

function ModelServiceEditor({
  id,
  service,
  environmentId,
  settings,
  readOnly,
  onDeleted,
}: {
  readonly id: ModelServiceId;
  readonly service: ModelServiceConfig | undefined;
  readonly environmentId: EnvironmentId;
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly readOnly: boolean;
  readonly onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const discover = useAtomCommand(serverEnvironment.discoverModelService, { reportFailure: false });
  const [name, setName] = useState(service?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [headers, setHeaders] = useState(JSON.stringify(service?.headers ?? {}, null, 2));
  const [selectedProtocols, setProtocols] = useState<ReadonlyArray<ModelServiceProtocol>>(
    service?.protocols ?? ["openai-chat"],
  );
  const [modelsPath, setModelsPath] = useState(service?.modelsPath ?? "");
  const [enabled, setEnabled] = useState(service?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [modelEditor, setModelEditor] = useState<null | "new" | ModelServiceModel>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const bound = Object.values(settings.providerInstances).filter(
    (instance) => instance.modelService?.serviceId === id,
  ).length;
  const models = service?.models ?? [];
  async function run(action: () => Promise<string | null>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const problem = await action();
      setError(problem ? t(problem) : null);
    } catch {
      setError(t("The model service operation failed."));
    }
    running.current = false;
    setBusy(false);
  }
  function configuration(): ModelServiceConfig | null {
    try {
      return decodeService({
        name,
        revision: service?.revision ?? 0,
        baseUrl,
        apiKey: clearKey ? "" : apiKey.trim() || service?.apiKey || "",
        headers: JSON.parse(headers),
        protocols: selectedProtocols,
        modelsPath,
        enabled,
        models,
        ...(service?.discoveredAt ? { discoveredAt: service.discoveredAt } : {}),
      });
    } catch {
      return null;
    }
  }
  async function save(fetchModels: boolean) {
    const config = configuration();
    if (!config) return "Check the service name, API URL, protocols and request headers.";
    const result = await update({
      environmentId,
      input: { patch: { modelServices: { [id]: config } } },
    });
    const problem = commandError(result);
    if (problem) return problem;
    setApiKey("");
    setClearKey(false);
    setHeaders(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(config.headers).map(([key, value]) => [key, value ? "••••••" : ""]),
        ),
        null,
        2,
      ),
    );
    return fetchModels
      ? commandError(await discover({ environmentId, input: { serviceId: id } }))
      : null;
  }
  return (
    <div className="space-y-4 rounded-lg border border-border p-3 sm:p-4">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => save(false));
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm">
            {t("Service name")}
            <Input
              value={name}
              disabled={readOnly || busy}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            {t("API URL")}
            <Input
              value={baseUrl}
              disabled={readOnly || busy}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              type="url"
              required
            />
          </label>
        </div>
        <label className="grid gap-1.5 text-sm">
          {t("API key")}
          <SecretInput
            value={apiKey}
            configured={Boolean(service?.apiKey) && !clearKey}
            disabled={readOnly || busy || clearKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        {service?.apiKey ? (
          <label className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={clearKey}
              disabled={readOnly || busy}
              onChange={(event) => setClearKey(event.target.checked)}
            />
            {t("Remove stored API key")}
          </label>
        ) : null}
        <fieldset disabled={readOnly || busy} className="space-y-2">
          <legend className="text-sm font-medium">{t("Supported protocols")}</legend>
          <p className="text-xs text-muted-foreground">
            {t(
              "The first selected protocol is used for model discovery. Each model can declare its own protocols.",
            )}
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {protocols.map((protocol) => (
              <label key={protocol} className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedProtocols.includes(protocol)}
                  onChange={(event) =>
                    setProtocols(
                      event.target.checked
                        ? [...selectedProtocols, protocol]
                        : selectedProtocols.filter((value) => value !== protocol),
                    )
                  }
                />
                {MODEL_SERVICE_PROTOCOL_LABELS[protocol]}
                {selectedProtocols[0] === protocol ? (
                  <span className="text-xs text-muted-foreground">{t("Primary")}</span>
                ) : null}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="grid gap-1.5 text-sm">
          {t("Model-list path")}
          <Input
            value={modelsPath}
            disabled={readOnly || busy}
            onChange={(event) => setModelsPath(event.target.value)}
            placeholder={t("Automatic")}
          />
          <span className="text-xs text-muted-foreground">
            {t("Optional path on the same service, such as /v1/models.")}
          </span>
        </label>
        <details>
          <summary className="cursor-pointer text-sm">{t("Additional request headers")}</summary>
          <label className="mt-2 grid gap-1.5 text-sm">
            <span className="sr-only">{t("Request headers JSON")}</span>
            <textarea
              aria-label={t("Request headers JSON")}
              className="min-h-24 w-full rounded-md border border-input bg-transparent p-2 font-mono text-base sm:text-sm"
              value={headers}
              disabled={readOnly || busy}
              onChange={(event) => setHeaders(event.target.value)}
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              {t("Header values are stored as secrets. Keep masked values to retain them.")}
            </span>
          </label>
        </details>
        <label className="flex min-h-10 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={readOnly || busy}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t("Enable model service")}
        </label>
        {!readOnly ? (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {t("Save service")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || !enabled}
              onClick={() => void run(() => save(true))}
            >
              {t(busy ? "Working…" : "Save and fetch models")}
            </Button>
          </div>
        ) : null}
      </form>
      {error ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">
          {t("Models")} ({models.length})
        </h3>
        {service && !readOnly ? (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !enabled || !models.length}
              onClick={() =>
                void run(async () =>
                  commandError(
                    await discover({
                      environmentId,
                      input: { serviceId: id, metadataOnly: true },
                    }),
                  ),
                )
              }
            >
              {t("Fill metadata from models.dev")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setModelEditor("new")}
            >
              {t("Add model")}
            </Button>
          </div>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Missing metadata is filled from models.dev using exact model IDs. Existing values are preserved; unmatched capabilities remain unknown.",
        )}
      </p>
      {models.length ? (
        <div className="max-h-96 overflow-y-auto divide-y divide-border">
          {models.map((model) => (
            <div key={model.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="break-all text-sm">
                  {!model.name || model.name === model.id
                    ? modelServiceDisplayName(model.id)
                    : model.name}
                </p>
                {model.available === false ? (
                  <p className="text-xs text-destructive">
                    {t("No longer advertised by the service")}
                  </p>
                ) : null}
                <p className="break-all font-mono text-xs text-muted-foreground">{model.id}</p>
                <p className="text-xs text-muted-foreground">
                  {t("Context")}:{" "}
                  {model.capabilities?.contextWindow?.toLocaleString() ?? t("Unknown")} ·{" "}
                  {(model.protocols ?? service?.protocols ?? [])
                    .map((protocol) => MODEL_SERVICE_PROTOCOL_LABELS[protocol])
                    .join(" / ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("Maximum output tokens")}:{" "}
                  {model.maxOutputTokens?.toLocaleString() ?? t("Unknown")} · {t("Image input")}:{" "}
                  {model.capabilities?.supportsImages === undefined
                    ? t("Unknown")
                    : model.capabilities.supportsImages
                      ? t("Supported")
                      : t("Unsupported")}{" "}
                  · {t("Tool calling")}:{" "}
                  {model.supportsTools === undefined
                    ? t("Unknown")
                    : model.supportsTools
                      ? t("Supported")
                      : t("Unsupported")}
                  {model.supportsReasoning !== undefined ? (
                    <>
                      {" "}
                      · {t("Reasoning")}:{" "}
                      {model.supportsReasoning ? t("Supported") : t("Unsupported")}
                    </>
                  ) : null}
                </p>
                {model.inputModalities || model.outputModalities ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Input modalities")}: {model.inputModalities?.join(" / ") ?? t("Unknown")} ·{" "}
                    {t("Output modalities")}: {model.outputModalities?.join(" / ") ?? t("Unknown")}
                  </p>
                ) : null}
              </div>
              {!readOnly ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setModelEditor(model)}
                >
                  {t("Edit")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("Fetch models or add them manually before binding an agent.")}
        </p>
      )}
      {modelEditor && service ? (
        <ModelEditor
          key={modelEditor === "new" ? "new" : modelEditor.id}
          model={modelEditor === "new" ? undefined : modelEditor}
          protocols={service.protocols}
          busy={busy}
          onCancel={() => setModelEditor(null)}
          onSave={(model) =>
            void run(async () => {
              const previousId = modelEditor === "new" ? null : modelEditor.id;
              const result = await update({
                environmentId,
                input: {
                  patch: {
                    modelServices: {
                      [id]: {
                        ...service,
                        models: [
                          ...models.filter(
                            (entry) => entry.id !== model.id && entry.id !== previousId,
                          ),
                          model,
                        ],
                      },
                    },
                  },
                },
              });
              const problem = commandError(result);
              if (!problem) setModelEditor(null);
              return problem;
            })
          }
        />
      ) : null}
      {service && !readOnly ? (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs text-muted-foreground">
            {t("Bound agents: {count}", { count: bound })}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || bound > 0}
            onClick={() => {
              if (!deleteArmed) {
                setDeleteArmed(true);
                return;
              }
              void run(async () => {
                const problem = commandError(
                  await update({
                    environmentId,
                    input: { patch: { modelServices: { [id]: null } } },
                  }),
                );
                if (!problem) onDeleted();
                return problem;
              });
            }}
          >
            {t(deleteArmed ? "Confirm removal" : "Remove service")}
          </Button>
          {bound > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("Unbind agents before removing this service.")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ModelEditor({
  model,
  protocols: defaults,
  busy,
  onCancel,
  onSave,
}: {
  readonly model: ModelServiceModel | undefined;
  readonly protocols: ReadonlyArray<ModelServiceProtocol>;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSave: (model: ModelServiceModel) => void;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState(model?.id ?? "");
  const [name, setName] = useState(model?.name ?? "");
  const [context, setContext] = useState(model?.capabilities?.contextWindow?.toString() ?? "");
  const [output, setOutput] = useState(model?.maxOutputTokens?.toString() ?? "");
  const [images, setImages] = useState(
    model?.capabilities?.supportsImages === undefined
      ? "unknown"
      : String(model.capabilities.supportsImages),
  );
  const [tools, setTools] = useState(
    model?.supportsTools === undefined ? "unknown" : String(model.supportsTools),
  );
  const [selected, setSelected] = useState<ReadonlyArray<ModelServiceProtocol>>(
    model?.protocols ?? defaults,
  );
  const validNumber = (value: string) =>
    value === "" || (Number.isSafeInteger(Number(value)) && Number(value) > 0);
  return (
    <form
      className="space-y-3 rounded-md border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!id.trim() || !validNumber(context) || !validNumber(output) || !selected.length) return;
        onSave({
          ...(model?.id === id.trim() && model.inputModalities
            ? { inputModalities: model.inputModalities }
            : {}),
          ...(model?.id === id.trim() && model.outputModalities
            ? { outputModalities: model.outputModalities }
            : {}),
          ...(model?.id === id.trim() && model.supportsReasoning !== undefined
            ? { supportsReasoning: model.supportsReasoning }
            : {}),
          id: id.trim(),
          name: name.trim() || modelServiceDisplayName(id.trim()),
          protocols: selected,
          capabilities: {
            ...model?.capabilities,
            contextWindow: context ? Number(context) : undefined,
            supportsImages: images === "unknown" ? undefined : images === "true",
          },
          ...(tools !== "unknown" ? { supportsTools: tools === "true" } : {}),
          ...(output ? { maxOutputTokens: Number(output) } : {}),
          source: "manual",
        });
      }}
    >
      <label className="grid gap-1 text-sm">
        {t("Model ID")}
        <Input
          value={id}
          onChange={(event) => setId(event.target.value)}
          required
          disabled={busy}
        />
      </label>
      <label className="grid gap-1 text-sm">
        {t("Display name")}
        <Input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          {t("Context window")}
          <Input
            value={context}
            onChange={(event) => setContext(event.target.value)}
            inputMode="numeric"
            placeholder={t("Unknown")}
            disabled={busy}
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("Maximum output tokens")}
          <Input
            value={output}
            onChange={(event) => setOutput(event.target.value)}
            inputMode="numeric"
            placeholder={t("Unknown")}
            disabled={busy}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          { label: "Image input", value: images, set: setImages },
          { label: "Tool calling", value: tools, set: setTools },
        ].map((field) => (
          <label key={field.label} className="grid gap-1 text-sm">
            {t(field.label)}
            <select
              className="min-h-10 rounded-md border border-input bg-background px-2"
              value={field.value}
              onChange={(event) => field.set(event.target.value)}
              disabled={busy}
            >
              <option value="unknown">{t("Unknown")}</option>
              <option value="true">{t("Supported")}</option>
              <option value="false">{t("Unsupported")}</option>
            </select>
          </label>
        ))}
      </div>
      <fieldset disabled={busy} className="grid gap-1 sm:grid-cols-2">
        <legend className="text-sm">{t("Supported protocols")}</legend>
        {defaults.map((protocol) => (
          <label key={protocol} className="flex min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.includes(protocol)}
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? [...selected, protocol]
                    : selected.filter((value) => value !== protocol),
                )
              }
            />
            {MODEL_SERVICE_PROTOCOL_LABELS[protocol]}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={
            busy || !id.trim() || !validNumber(context) || !validNumber(output) || !selected.length
          }
        >
          {t("Save model")}
        </Button>
        <Button size="sm" type="button" variant="outline" disabled={busy} onClick={onCancel}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}
