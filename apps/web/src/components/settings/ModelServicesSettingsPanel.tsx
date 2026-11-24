import {
  ModelServiceConfig,
  type ModelServiceDiscoveryResult,
  DEFAULT_MODEL_SERVICE_RECOVERY,
  ModelServiceId,
  type EnvironmentId,
  type ModelServiceModel,
  type ModelServiceProtocol,
  type ModelServiceEncryptedReasoningReplay,
  type ServerSettings,
} from "@t3tools/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createModelServiceTestRunner } from "@t3tools/client-runtime/state/model-service-tests";
import {
  modelServiceCandidateProtocols,
  modelServiceDisplayName,
  modelServiceProtocols,
  modelServiceSources,
  modelServiceSplitPlan,
} from "@t3tools/shared/modelServices";
import * as Schema from "effect/Schema";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useTranslation } from "../../i18n";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn, randomUUID } from "../../lib/utils";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  GripVerticalIcon,
  Layers3Icon,
  MoreHorizontalIcon,
  PlusIcon,
  PencilIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "../ui/button";
import {
  isUsagePriceEdit,
  parseUsagePriceForm,
  usagePriceForm,
  USAGE_PRICE_FIELDS,
} from "../usage/usagePriceForm";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SecretInput } from "./SecretInput";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { ModelServiceRecoverySettings } from "./ModelServiceRecoverySettings";
import { ModelImportDialog } from "./ModelImportDialog";
import {
  modelRemovalBlockingAgents,
  modelRemovalPlan,
  modelsRemovalBlockingAgents,
  unlistedModelRemovalPlan,
} from "./ModelServicesSettingsPanel.logic";

export const MODEL_SERVICE_PROTOCOL_LABELS: Record<ModelServiceProtocol, string> = {
  "openai-responses": "OpenAI Responses",
  "openai-chat": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
  gemini: "Gemini",
};
const protocols = Object.keys(MODEL_SERVICE_PROTOCOL_LABELS) as ModelServiceProtocol[];
const decodeService = Schema.decodeUnknownSync(ModelServiceConfig);
const MODEL_PRICE_LABELS = {
  inputCostPerMillionTokens: "Input price",
  outputCostPerMillionTokens: "Output price",
  cacheReadCostPerMillionTokens: "Cache read price",
  cacheWriteCostPerMillionTokens: "Cache write price",
} as const;
const serviceReorderControlClass =
  "inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-accent/80 disabled:cursor-default disabled:opacity-40 min-[641px]:min-h-7 min-[641px]:min-w-7";

function modelTestMessage(message: string, t: ReturnType<typeof useTranslation>["t"]) {
  const status = /^Model test failed \(HTTP ([0-9]{3})\)\.$/.exec(message)?.[1];
  return status ? t("Model test failed (HTTP {status}).", { status }) : t(message);
}

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
    <SettingsPageContainer width="wide">
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
  const compactPhone = useMediaQuery("max-sm");
  const settings = useEnvironmentSettings(environmentId);
  const canManage = useEnvironmentScope(environmentId, "providers:manage");
  const readOnly = !canManage || projectScoped;
  const [editing, setEditing] = useState<ModelServiceId | null>(null);
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const services = settings.modelServices;
  const unorderedEntries = Object.entries(services) as Array<[ModelServiceId, ModelServiceConfig]>;
  const orderedIds = new Set<ModelServiceId>();
  const entries: Array<[ModelServiceId, ModelServiceConfig]> = [];
  for (const id of settings.modelServiceOrder) {
    const service = services[id];
    if (service === undefined || orderedIds.has(id)) continue;
    orderedIds.add(id);
    entries.push([id, service]);
  }
  for (const entry of unorderedEntries) {
    if (!orderedIds.has(entry[0])) entries.push(entry);
  }
  const first = entries[0]?.[0];
  const selected = editing ?? first;
  const persistOrder = (nextOrder: ReadonlyArray<ModelServiceId>) => {
    void update({ environmentId, input: { patch: { modelServiceOrder: [...nextOrder] } } });
  };
  const moveService = (id: ModelServiceId, direction: -1 | 1) => {
    const index = entries.findIndex(([entryId]) => entryId === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= entries.length) return;
    const nextOrder = entries.map(([entryId]) => entryId);
    const current = nextOrder[index];
    const displaced = nextOrder[nextIndex];
    if (current === undefined || displaced === undefined) return;
    nextOrder[index] = displaced;
    nextOrder[nextIndex] = current;
    persistOrder(nextOrder);
  };
  const dropService = (sourceId: ModelServiceId, targetId: ModelServiceId) => {
    const sourceIndex = entries.findIndex(([entryId]) => entryId === sourceId);
    const targetIndex = entries.findIndex(([entryId]) => entryId === targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    const nextOrder = entries.map(([entryId]) => entryId);
    const [moved] = nextOrder.splice(sourceIndex, 1);
    if (moved === undefined) return;
    nextOrder.splice(targetIndex, 0, moved);
    persistOrder(nextOrder);
  };
  return (
    <SettingsSection
      title={t("Model services")}
      id="model-services"
      variant="plain"
      headerAction={
        !readOnly ? (
          <Button
            size={compactPhone ? "touch" : "sm"}
            variant="outline"
            onClick={() => setEditing(ModelServiceId.make(`service_${randomUUID()}`))}
          >
            <PlusIcon />
            {t("Add model service")}
          </Button>
        ) : undefined
      }
    >
      <p className="px-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
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
        <div className="px-3 sm:px-4">
          <div
            role="group"
            aria-label={t("Configured model services")}
            className="flex flex-wrap gap-1.5 rounded-xl border border-border/60 bg-muted/25 p-1.5"
          >
            {entries.map(([id, service], index) => {
              const active = selected === id;
              return (
                <div
                  key={id}
                  data-model-service-row={id}
                  className="flex w-full min-w-0 items-center gap-1 min-[641px]:w-auto"
                  onDragOver={(event) => {
                    if (readOnly) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    if (readOnly) return;
                    event.preventDefault();
                    const transferredId = event.dataTransfer.getData("text/plain");
                    const source = entries.find(([entryId]) => entryId === transferredId);
                    if (source) dropService(source[0], id);
                  }}
                >
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => setEditing(id)}
                    className={cn(
                      "group flex min-h-11 w-full min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2 text-left outline-hidden transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring min-[641px]:w-auto min-[641px]:min-w-60",
                      active
                        ? "bg-background text-foreground shadow-xs/10 ring-1 ring-border/70"
                        : "text-muted-foreground hover:bg-background/65 hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                        active
                          ? "bg-primary/10 text-primary"
                          : "bg-background/60 text-muted-foreground group-hover:bg-background",
                      )}
                    >
                      <Layers3Icon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{service.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(service.models.length === 1 ? "{name} model" : "{name} models", {
                          name: service.models.length,
                        })}
                      </span>
                    </span>
                    {active ? (
                      <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden="true" />
                    ) : null}
                  </button>
                  {!readOnly ? (
                    <div className="flex shrink-0 items-center gap-0.5">
                      {compactPhone ? null : (
                        <button
                          type="button"
                          draggable
                          aria-label={t("Drag {name}", { name: service.name })}
                          title={t("Drag {name}", { name: service.name })}
                          className={cn(
                            serviceReorderControlClass,
                            "cursor-grab active:cursor-grabbing",
                          )}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", id);
                          }}
                        >
                          <GripVerticalIcon className="size-4" aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={index === 0}
                        aria-label={t("Move {name} up", { name: service.name })}
                        title={t("Move up")}
                        className={serviceReorderControlClass}
                        onClick={() => moveService(id, -1)}
                      >
                        <ArrowUpIcon className="size-4" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        disabled={index === entries.length - 1}
                        aria-label={t("Move {name} down", { name: service.name })}
                        title={t("Move down")}
                        className={serviceReorderControlClass}
                        onClick={() => moveService(id, 1)}
                      >
                        <ArrowDownIcon className="size-4" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : !selected ? (
        <SettingsRow
          title={t("No model services configured.")}
          description={t("Add a service with its API URL, API key and protocol.")}
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
  readonly settings: Pick<ServerSettings, "providerInstances" | "modelServices">;
  readonly readOnly: boolean;
  readonly onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const discover = useAtomCommand(serverEnvironment.discoverModelService, { reportFailure: false });
  const testModel = useAtomCommand(serverEnvironment.testModelService, { reportFailure: false });
  const [tester] = useState(createModelServiceTestRunner);
  const tests = useSyncExternalStore(tester.subscribe, tester.getSnapshot, tester.getSnapshot);
  const testConfiguration = service ? `${service.revision}:${service.baseUrl}` : null;
  useEffect(() => {
    if (testConfiguration !== null) tester.clear();
    return tester.cancel;
  }, [tester, testConfiguration]);
  const [name, setName] = useState(service?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(service?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [headers, setHeaders] = useState(JSON.stringify(service?.headers ?? {}, null, 2));
  const serviceProtocols = service ? modelServiceProtocols(service) : [];
  const legacy = new Set(serviceProtocols).size > 1;
  const [protocol, setProtocol] = useState<ModelServiceProtocol>(
    serviceProtocols[0] ?? "openai-chat",
  );
  const [modelsPath, setModelsPath] = useState(service?.modelsPath ?? "");
  const [enabled, setEnabled] = useState(service?.enabled ?? true);
  const [recovery, setRecovery] = useState(service?.recovery ?? DEFAULT_MODEL_SERVICE_RECOVERY);
  const [encryptedReasoningReplay, setEncryptedReasoningReplay] = useState<
    ModelServiceEncryptedReasoningReplay | undefined
  >(service?.encryptedReasoningReplay);
  const [error, setError] = useState<string | null>(null);
  const [saving, setBusy] = useState(false);
  const busy = saving || tests.running;
  const running = useRef(false);
  const [modelEditor, setModelEditor] = useState<null | "new" | ModelServiceModel>(null);
  const [importPreview, setImportPreview] = useState<ModelServiceDiscoveryResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewRequest = useRef<{ readonly cancel: () => void } | null>(null);
  useEffect(
    () => () => {
      previewRequest.current?.cancel();
    },
    [],
  );
  const [removingModel, setRemovingModel] = useState<ModelServiceModel | null>(null);
  const [bulkRemoval, setBulkRemoval] = useState<{
    readonly kind: "unlisted" | "failed";
    readonly modelIds: readonly string[];
    readonly revision: number;
  } | null>(null);
  const [cleanupResult, setCleanupResult] = useState<{
    count: number;
    kind: "unlisted" | "failed";
  } | null>(null);
  const [clearingModels, setClearingModels] = useState<{
    readonly revision: number;
    readonly modelIds: readonly string[];
  } | null>(null);
  const cancelModelRemoval = useRef<HTMLButtonElement>(null);
  const cancelBulkRemoval = useRef<HTMLButtonElement>(null);
  const cancelClearModels = useRef<HTMLButtonElement>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [splitRevision, setSplitRevision] = useState<number | null>(null);
  const splitPlan = splitRevision === null ? [] : modelServiceSplitPlan(settings.modelServices, id);
  const splitChanged = splitRevision !== null && service?.revision !== splitRevision;
  const bound = Object.values(settings.providerInstances).filter(
    (instance) =>
      instance.modelService &&
      modelServiceSources(instance.modelService).some((source) => source.serviceId === id),
  ).length;
  const models = service?.models ?? [];
  const cleanup = service
    ? unlistedModelRemovalPlan(id, service, settings.providerInstances, settings.modelServices)
    : { removable: [], protected: [] };
  const unlistedCount = cleanup.removable.length + cleanup.protected.length;
  const removalBlockers =
    service && removingModel
      ? modelRemovalBlockingAgents(
          id,
          service,
          removingModel.id,
          settings.providerInstances,
          settings.modelServices,
        )
      : [];
  const canRemoveModel =
    !readOnly &&
    removingModel !== null &&
    models.some((model) => model.id === removingModel.id) &&
    removalBlockers.length === 0;
  const clearBlockers = service
    ? modelsRemovalBlockingAgents(
        id,
        service,
        new Set(models.map((model) => model.id)),
        settings.providerInstances,
        settings.modelServices,
      )
    : [];
  const clearChanged =
    clearingModels !== null &&
    (service?.revision !== clearingModels.revision ||
      models.length !== clearingModels.modelIds.length ||
      models.some((model, index) => model.id !== clearingModels.modelIds[index]));
  const failed = new Set(
    [...tests.results]
      .filter(([, result]) => !result.ok && result.revision === service?.revision)
      .map(([modelId]) => modelId),
  );
  const failedPlan = service
    ? modelRemovalPlan(
        id,
        service,
        models.filter((model) => failed.has(model.id)),
        settings.providerInstances,
        settings.modelServices,
      )
    : { removable: [], protected: [] };
  const bulkPlan = bulkRemoval?.kind === "failed" ? failedPlan : cleanup;
  const bulkModels = bulkPlan.removable.filter((model) => bulkRemoval?.modelIds.includes(model.id));
  const bulkChanged = bulkRemoval !== null && service?.revision !== bulkRemoval.revision;
  const connectionChanged = Boolean(
    !service ||
    baseUrl !== service.baseUrl ||
    apiKey ||
    clearKey ||
    headers !== JSON.stringify(service.headers, null, 2) ||
    modelsPath !== (service.modelsPath ?? "") ||
    (!legacy && protocol !== serviceProtocols[0]),
  );
  const changed = Boolean(
    service &&
    (connectionChanged ||
      name !== service.name ||
      enabled !== service.enabled ||
      (encryptedReasoningReplay ?? "preserve") !==
        (service.encryptedReasoningReplay ?? "preserve") ||
      JSON.stringify(recovery) !== JSON.stringify(service.recovery)),
  );
  const fetchOnSave = !service || connectionChanged;
  const importChanged = Boolean(importPreview && service?.revision !== importPreview.revision);
  const importAdvertisedIds = new Set(importPreview?.models.map((model) => model.id) ?? []);
  const importUnlistedCount = importPreview
    ? models.filter(
        (model) =>
          model.source !== "manual" &&
          model.available !== false &&
          !importAdvertisedIds.has(model.id),
      ).length
    : 0;
  async function run(action: () => Promise<string | null>) {
    if (running.current || tests.running) return;
    running.current = true;
    setBusy(true);
    setError(null);
    setCleanupResult(null);
    try {
      const problem = await action();
      setError(problem ? t(problem) : null);
    } catch {
      setError(t("The model service operation failed."));
    }
    running.current = false;
    setBusy(false);
  }
  function saveModel(model: ModelServiceModel) {
    if (readOnly || !service || !modelEditor) return;
    const previousId = modelEditor === "new" ? null : modelEditor.id;
    const catalogPrice =
      previousId === model.id
        ? models.find((entry) => entry.id === previousId)?.modelsDevPrice
        : undefined;
    const nextModel = catalogPrice ? { ...model, modelsDevPrice: catalogPrice } : model;
    void run(async () => {
      const nextModels =
        previousId === null
          ? [...models.filter((entry) => entry.id !== model.id), nextModel]
          : models
              .filter((entry) => entry.id !== model.id || entry.id === previousId)
              .map((entry) => (entry.id === previousId ? nextModel : entry));
      const problem = commandError(
        await update({
          environmentId,
          input: { patch: { modelServices: { [id]: { ...service, models: nextModels } } } },
        }),
      );
      if (!problem) setModelEditor(null);
      return problem;
    });
  }
  function configuration(): ModelServiceConfig | null {
    try {
      return decodeService({
        name,
        revision: service?.revision ?? 0,
        baseUrl,
        apiKey: clearKey ? "" : apiKey.trim() || service?.apiKey || "",
        headers: JSON.parse(headers),
        ...(legacy ? { protocols: serviceProtocols } : { protocol }),
        modelsPath,
        enabled,
        recovery,
        ...(encryptedReasoningReplay !== undefined ? { encryptedReasoningReplay } : {}),
        models,
        ...(service?.discoveredAt ? { discoveredAt: service.discoveredAt } : {}),
      });
    } catch {
      return null;
    }
  }
  async function previewModels() {
    let cancel = () => {};
    const request = {
      cancel: () => cancel(),
    };
    previewRequest.current = request;
    setPreviewing(true);
    return Promise.race([
      discover({ environmentId, input: { serviceId: id, preview: true } }),
      new Promise<"cancelled">((resolve) => {
        cancel = () => resolve("cancelled");
      }),
    ])
      .then((result) => {
        if (previewRequest.current !== request || result === "cancelled") return null;
        if (result._tag !== "Success") return commandError(result);
        setImportPreview(result.value);
        return null;
      })
      .finally(() => {
        if (previewRequest.current === request) {
          previewRequest.current = null;
          setPreviewing(false);
        }
      });
  }
  function importModels(modelIds: readonly string[]) {
    const preview = importPreview;
    if (readOnly || !service || !preview || importChanged) return;
    const selected = new Set(modelIds);
    const advertised = importAdvertisedIds;
    const imported = new Map(
      preview.models.filter((model) => selected.has(model.id)).map((model) => [model.id, model]),
    );
    const nextModels = models.map((model) => {
      const replacement = imported.get(model.id);
      if (replacement) return replacement;
      return model.source !== "manual" && !advertised.has(model.id)
        ? { ...model, available: false }
        : model;
    });
    const currentIds = new Set(models.map((model) => model.id));
    for (const model of imported.values()) {
      if (!currentIds.has(model.id)) nextModels.push(model);
    }
    void run(async () => {
      const problem = commandError(
        await update({
          environmentId,
          input: {
            patch: {
              modelServiceImport: {
                serviceId: id,
                fingerprint: preview.fingerprint,
                models: nextModels,
                discoveredAt: preview.discoveredAt,
              },
            },
          },
        }),
      );
      if (problem) return problem;
      setImportPreview(null);
      const [firstModelId, ...remainingModelIds] = imported.keys();
      if (firstModelId === undefined) return null;
      try {
        const result = await discover({
          environmentId,
          input: {
            serviceId: id,
            metadataOnly: true,
            metadataModelIds: [firstModelId, ...remainingModelIds],
          },
        });
        if (result._tag === "Success") return null;
      } catch {
        return "Models were imported, but models.dev metadata could not be synced. You can retry using metadata sync.";
      }
      return "Models were imported, but models.dev metadata could not be synced. You can retry using metadata sync.";
    });
  }
  async function save(fetchModels: boolean) {
    const config = configuration();
    if (!config) return "Check the service name, API URL, protocol and request headers.";
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
    return fetchModels ? previewModels() : null;
  }
  return (
    <div className="mx-3 overflow-hidden rounded-xl border border-border/60 bg-card/40 shadow-xs/5 sm:mx-4">
      <form
        className="grid lg:grid-cols-[minmax(0,3fr)_minmax(16rem,2fr)]"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => save(fetchOnSave));
        }}
      >
        <div className="space-y-6 p-4 sm:space-y-5 sm:p-5 lg:p-6">
          <div className="grid gap-5 sm:grid-cols-2 sm:gap-4">
            <label className="grid gap-2 text-sm font-medium">
              {t("Service name")}
              <Input
                value={name}
                disabled={readOnly || busy}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label className="grid gap-2 text-sm font-medium">
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
          <label className="grid gap-2 text-sm font-medium">
            {t("API key")}
            <SecretInput
              value={apiKey}
              configured={Boolean(service?.apiKey) && !clearKey}
              disabled={readOnly || busy || clearKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          {service?.apiKey ? (
            <label className="flex min-h-11 w-fit cursor-pointer items-center gap-2.5 text-sm">
              <Checkbox
                checked={clearKey}
                disabled={readOnly || busy}
                onCheckedChange={(checked) => setClearKey(checked === true)}
              />
              {t("Remove stored API key")}
            </label>
          ) : null}
        </div>
        <div className="space-y-5 p-4 sm:p-5 lg:border-l lg:border-border/60 lg:bg-muted/10 lg:p-6">
          {legacy ? (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t("API protocol")}</legend>
              <p className="text-sm">
                {serviceProtocols.map((entry) => MODEL_SERVICE_PROTOCOL_LABELS[entry]).join(" / ")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("Split this legacy service into one connection per protocol.")}
              </p>
              {!readOnly && service ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || changed}
                  onClick={() => {
                    setError(null);
                    setSplitRevision(service.revision);
                  }}
                >
                  {t("Preview protocol split")}
                </Button>
              ) : null}
            </fieldset>
          ) : (
            <label className="grid gap-1.5 text-sm font-medium">
              <span>{t("API protocol")}</span>
              <select
                className="min-h-11 min-w-0 rounded-md border border-input bg-background px-2 font-normal"
                disabled={readOnly || busy}
                value={protocol}
                onChange={(event) => setProtocol(event.target.value as ModelServiceProtocol)}
              >
                {protocols.map((entry) => (
                  <option key={entry} value={entry}>
                    {MODEL_SERVICE_PROTOCOL_LABELS[entry]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="grid gap-2 text-sm font-medium">
            <span className="flex items-center justify-between gap-3">
              {t("Model-list path")}
              <span className="text-xs font-normal text-muted-foreground">{t("Automatic")}</span>
            </span>
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
          <details className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2.5 open:pb-3">
            <summary className="cursor-pointer text-sm font-medium">
              {t("Additional request headers")}
            </summary>
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
          <label className="flex min-h-11 w-fit cursor-pointer items-center gap-2.5 text-sm">
            <Checkbox
              checked={enabled}
              disabled={readOnly || busy}
              onCheckedChange={(checked) => setEnabled(checked === true)}
            />
            {t("Enable model service")}
          </label>
          <ModelServiceRecoverySettings
            value={recovery}
            disabled={readOnly || busy}
            onChange={setRecovery}
          />
          <label className="grid gap-2 text-sm font-medium">
            {t("Encrypted reasoning replay")}
            <select
              aria-label={t("Encrypted reasoning replay")}
              className="min-h-10 min-w-0 rounded-md border border-input bg-background px-2"
              value={encryptedReasoningReplay ?? "preserve"}
              disabled={readOnly || busy}
              onChange={(event) =>
                setEncryptedReasoningReplay(event.target.value === "omit" ? "omit" : "preserve")
              }
            >
              <option value="preserve">{t("Preserve (default)")}</option>
              <option value="omit">{t("Omit for incompatible services")}</option>
            </select>
            <span className="text-xs font-normal leading-relaxed text-muted-foreground">
              {t(
                "Applies to OpenAI Responses after protocol conversion, including Claude, Pi and Codex. Omit encrypted reasoning from the first request without changing messages, tools or saved history. Models can override this setting.",
              )}
            </span>
          </label>
        </div>
        {!readOnly ? (
          <div className="grid gap-2 lg:col-span-2 lg:border-t lg:border-border/60 lg:p-5 lg:pt-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                {t(
                  fetchOnSave
                    ? "The connection changed. Saving will also fetch models for review before importing."
                    : "Only settings are saved. The model catalog is unchanged.",
                )}
              </p>
              <Button type="submit" disabled={busy}>
                <RefreshCwIcon />
                {t(busy ? "Working…" : fetchOnSave ? "Save and fetch models" : "Save changes")}
              </Button>
            </div>
          </div>
        ) : null}
      </form>
      {error &&
      !importPreview &&
      !removingModel &&
      !bulkRemoval &&
      !clearingModels &&
      !modelEditor ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={splitRevision !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setSplitRevision(null);
        }}
      >
        <AlertDialogPopup bottomStickOnMobile={false}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Split model service by protocol")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Each connection uses the existing credentials. Existing Agent bindings and model selections follow the models below. Alternate protocols will require their own model selection.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="max-h-64 space-y-3 overflow-auto text-sm">
            {splitPlan.map((part) => (
              <div key={part.serviceId}>
                <p className="font-medium">
                  {MODEL_SERVICE_PROTOCOL_LABELS[part.protocol]} ({part.models.length})
                </p>
                <ul>
                  {part.models.map(({ model, alternatives }) => (
                    <li key={model.id} className="break-all">
                      {model.name ?? model.id}
                      {alternatives.length ? (
                        <span className="block text-xs text-muted-foreground">
                          {t("Previously eligible fallbacks: {protocols}", {
                            protocols: alternatives
                              .map((entry) => MODEL_SERVICE_PROTOCOL_LABELS[entry])
                              .join(", "),
                          })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {splitChanged || error ? (
            <p role="alert" className="text-sm text-destructive">
              {error ??
                t("The model service changed. Close this dialog and preview the split again.")}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              disabled={
                busy || readOnly || splitChanged || splitPlan.length < 2 || splitRevision === null
              }
              onClick={() => {
                if (splitRevision === null) return;
                void run(async () => {
                  const problem = commandError(
                    await update({
                      environmentId,
                      input: {
                        patch: { splitModelService: { serviceId: id, revision: splitRevision } },
                      },
                    }),
                  );
                  if (!problem) {
                    setSplitRevision(null);
                    setName(`${service?.name} · ${protocol}`);
                  }
                  return problem;
                });
              }}
            >
              {t("Split model service")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {importPreview && service ? (
        <ModelImportDialog
          key={`${importPreview.revision}:${importPreview.discoveredAt}`}
          preview={importPreview}
          existingModels={models}
          serviceName={service.name}
          unlistedCount={importUnlistedCount}
          busy={busy}
          error={error}
          revisionChanged={importChanged}
          onCancel={() => {
            setImportPreview(null);
            setError(null);
          }}
          onImport={importModels}
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/10 px-4 py-4 sm:px-5 lg:px-6">
        <h3 className="text-sm font-medium">
          {t("Models")} ({models.length})
        </h3>
        {service && !readOnly ? (
          <div className="flex min-w-0 max-w-full flex-wrap gap-2 max-sm:[&_button]:min-h-11">
            {previewing ? (
              <Button size="sm" variant="outline" onClick={() => previewRequest.current?.cancel()}>
                {t("Cancel fetch")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || !enabled || changed}
                title={changed ? t("Save changes before refreshing models") : undefined}
                onClick={() => void run(previewModels)}
              >
                <RefreshCwIcon />
                {t("Refresh models")}
              </Button>
            )}
            {tests.running ? (
              <Button size="sm" variant="outline" onClick={tester.cancel}>
                {t("Stop remaining tests")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy || !enabled || changed || !models.some((model) => model.available !== false)
                }
                onClick={() => {
                  void tester.run(
                    models.filter((model) => model.available !== false).map((model) => model.id),
                    service.revision,
                    async (modelId) => {
                      const result = await testModel({
                        environmentId,
                        input: { serviceId: id, revision: service.revision, modelId },
                      });
                      if (result._tag !== "Success") throw new Error("Model test interrupted");
                      return result.value;
                    },
                  );
                }}
              >
                {t("Test all models")}
              </Button>
            )}
            <div className="flex min-w-0 max-w-full">
              <Button
                size="sm-multiline"
                fill
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
                {t("Sync prices and metadata from models.dev")}
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setError(null);
                setModelEditor("new");
              }}
            >
              <PlusIcon />
              {t("Add model")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || changed || models.length === 0}
              onClick={() => {
                setError(null);
                setClearingModels({
                  revision: service.revision,
                  modelIds: models.map((model) => model.id),
                });
              }}
            >
              <Trash2Icon />
              {t("Clear models")}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="space-y-4 bg-muted/10 px-4 pb-4 sm:px-5 sm:pb-5 lg:px-6 lg:pb-6">
        {previewing && service ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("Fetching models from {service}…", { service: service.name })}
          </p>
        ) : null}
        {service && !readOnly && unlistedCount > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/60 p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm">
                {t("{count} models are no longer listed by the service.", { count: unlistedCount })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("Manual models and models selected or required by agents are kept.")}
              </p>
              {cleanup.removable.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    "All unlisted models are required by agent bindings. Adjust the bindings before cleaning up.",
                  )}
                </p>
              ) : null}
            </div>
            <Button
              size="sm-multiline"
              variant="outline"
              disabled={busy || changed || cleanup.removable.length === 0}
              title={changed ? t("Save changes before cleaning up models") : undefined}
              onClick={() => {
                setError(null);
                setBulkRemoval({
                  kind: "unlisted",
                  modelIds: cleanup.removable.map((model) => model.id),
                  revision: service.revision,
                });
              }}
            >
              <Trash2Icon />
              {t("Delete unlisted models ({count})", { count: cleanup.removable.length })}
            </Button>
          </div>
        ) : null}
        {cleanupResult !== null ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t(
              cleanupResult.kind === "failed"
                ? cleanupResult.count === 1
                  ? "Deleted one failed model."
                  : "Deleted {count} failed models."
                : "Deleted {count} unlisted models.",
              { count: cleanupResult.count },
            )}
          </p>
        ) : null}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("Testing sends small requests using saved settings and may incur provider charges.")}
        </p>
        {tests.total > 0 && (
          <p role="status" className="text-xs text-muted-foreground">
            {t("Tested {completed}/{total}: {passed} passed, {failed} failed.", {
              completed: tests.results.size,
              total: tests.total,
              passed: [...tests.results.values()].filter((result) => result.ok).length,
              failed: failed.size,
            })}
          </p>
        )}
        {service && !readOnly && !tests.running && failed.size > 0 ? (
          <Button
            size="sm-multiline"
            variant="outline"
            disabled={busy || changed}
            onClick={() => {
              setError(null);
              setBulkRemoval({
                kind: "failed",
                modelIds: failedPlan.removable.map((model) => model.id),
                revision: service.revision,
              });
            }}
          >
            {t("Review failed models ({count})", { count: failed.size })}
          </Button>
        ) : null}
        {tests.error && (
          <p role="alert" className="text-xs text-destructive">
            {t(tests.error)}
          </p>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t(
            "Importing automatically fills matching model information and prices from models.dev. Manual prices take priority.",
          )}
        </p>
        {modelEditor === "new" && service && !readOnly ? (
          <ModelEditor
            key="new"
            model={undefined}
            protocols={serviceProtocols}
            busy={busy}
            error={error}
            onCancel={() => {
              setModelEditor(null);
              setError(null);
            }}
            onSave={saveModel}
          />
        ) : null}
        {models.length ? (
          <div
            className={cn(
              "min-w-0 divide-y divide-border rounded-lg border border-border/60 bg-background/60 px-3",
              (modelEditor === null || modelEditor === "new") && "max-h-96 overflow-y-auto",
            )}
          >
            {models.map((model) => (
              <div
                key={model.id}
                data-model-row={model.id}
                className="grid min-w-0 gap-3 py-3 max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-11"
              >
                <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
                  <p className="break-all text-sm">
                    {!model.name || model.name === model.id
                      ? modelServiceDisplayName(model.id)
                      : model.name}
                  </p>
                  {!readOnly ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="icon-xl"
                        variant="ghost"
                        disabled={busy}
                        aria-label={t("Edit model {model}", { model: model.name ?? model.id })}
                        onClick={() => {
                          setError(null);
                          setModelEditor(model);
                        }}
                      >
                        <PencilIcon />
                      </Button>
                      <Menu>
                        <MenuTrigger
                          render={
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              disabled={busy}
                              aria-label={t("Model actions for {model}", {
                                model: model.name ?? model.id,
                              })}
                            />
                          }
                        >
                          <MoreHorizontalIcon />
                        </MenuTrigger>
                        <MenuPopup align="end">
                          <MenuItem
                            disabled={busy}
                            onClick={() => {
                              if (!readOnly) {
                                setError(null);
                                setModelEditor(model);
                              }
                            }}
                          >
                            {t("Edit")}
                          </MenuItem>
                          <MenuItem
                            variant="destructive"
                            disabled={busy}
                            aria-label={t("Delete model {model}", {
                              model: model.name ?? model.id,
                            })}
                            onClick={() => {
                              if (readOnly) return;
                              setError(null);
                              setRemovingModel(model);
                            }}
                          >
                            <Trash2Icon />
                            {t("Delete model")}
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </div>
                  ) : null}
                  <div className="col-span-2 min-w-0 space-y-1">
                    {model.price || model.modelsDevPrice ? (
                      <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                        <span>{t(model.price ? "Manual price" : "models.dev price")}</span>
                        <span>{t("USD per 1M tokens")}</span>
                        {USAGE_PRICE_FIELDS.map(({ key }) => {
                          const amount = (model.price ?? model.modelsDevPrice)?.[key];
                          return amount === undefined ? null : (
                            <span key={key}>
                              {t(MODEL_PRICE_LABELS[key])}{" "}
                              {amount.toLocaleString(undefined, { maximumSignificantDigits: 12 })}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                    {model.available === false ? (
                      <p className="text-xs text-destructive">
                        {t("No longer advertised by the service")}
                      </p>
                    ) : null}
                    {tests.active.has(model.id) && (
                      <p className="text-xs text-muted-foreground">{t("Testing…")}</p>
                    )}
                    {tests.results.get(model.id) && (
                      <p
                        className={
                          tests.results.get(model.id)!.ok
                            ? "text-xs text-muted-foreground"
                            : "text-xs text-destructive"
                        }
                      >
                        {tests.results.get(model.id)!.ok
                          ? t("Test passed ({duration} ms)", {
                              duration: Math.round(tests.results.get(model.id)!.durationMs),
                            })
                          : modelTestMessage(
                              tests.results.get(model.id)!.message ?? "Model test failed.",
                              t,
                            )}
                      </p>
                    )}
                    <p className="break-all font-mono text-xs text-muted-foreground">{model.id}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("Context")}:{" "}
                      {model.capabilities?.contextWindow?.toLocaleString() ?? t("Unknown")} ·{" "}
                      {(service && legacy
                        ? [
                            ...modelServiceCandidateProtocols(service, model),
                            ...(model.protocols ?? []).filter(
                              (protocol) => !serviceProtocols.includes(protocol),
                            ),
                          ]
                        : (model.protocols ?? serviceProtocols)
                      )
                        .map((protocol) => MODEL_SERVICE_PROTOCOL_LABELS[protocol])
                        .join(" / ")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("Maximum output tokens")}:{" "}
                      {model.maxOutputTokens?.toLocaleString() ?? t("Unknown")} · {t("Image input")}
                      :{" "}
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
                        {t("Input modalities")}:{" "}
                        {model.inputModalities?.join(" / ") ?? t("Unknown")} ·{" "}
                        {t("Output modalities")}:{" "}
                        {model.outputModalities?.join(" / ") ?? t("Unknown")}
                      </p>
                    ) : null}
                  </div>
                </div>
                {modelEditor !== null &&
                modelEditor !== "new" &&
                modelEditor.id === model.id &&
                service &&
                !readOnly ? (
                  <ModelEditor
                    key={modelEditor.id}
                    model={modelEditor}
                    protocols={serviceProtocols}
                    busy={busy}
                    error={error}
                    onCancel={() => {
                      setModelEditor(null);
                      setError(null);
                    }}
                    onSave={saveModel}
                  />
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border/70 px-4 py-5 text-sm text-muted-foreground">
            {t("Fetch models or add them manually before binding an agent.")}
          </p>
        )}
      </div>
      <AlertDialog
        open={clearingModels !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setClearingModels(null);
        }}
      >
        <AlertDialogPopup initialFocus={cancelClearModels} bottomStickOnMobile={false}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Clear all {count} models?", { count: clearingModels?.modelIds.length ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Remove all models from this service's local catalog, including manual models. You can import advertised models again.",
              )}
            </AlertDialogDescription>
            {clearBlockers.length > 0 ? (
              <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {t(
                  "These agents use this service: {agents}. Unbind them before clearing its models.",
                  { agents: clearBlockers.join(", ") },
                )}
              </p>
            ) : null}
            {clearChanged || changed ? (
              <p role="alert" className="text-sm text-destructive">
                {t(
                  "The model catalog or connection changed. Close this dialog and review the cleanup again.",
                )}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button ref={cancelClearModels} variant="outline" disabled={busy} />}
            >
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={
                busy ||
                readOnly ||
                changed ||
                clearChanged ||
                models.length === 0 ||
                clearBlockers.length > 0
              }
              onClick={() => {
                if (
                  !service ||
                  readOnly ||
                  changed ||
                  clearChanged ||
                  models.length === 0 ||
                  clearBlockers.length > 0
                )
                  return;
                void run(async () => {
                  const problem = commandError(
                    await update({
                      environmentId,
                      input: { patch: { modelServices: { [id]: { ...service, models: [] } } } },
                    }),
                  );
                  if (!problem) {
                    setModelEditor(null);
                    setClearingModels(null);
                    tester.clear();
                  }
                  return problem;
                });
              }}
            >
              {t(busy ? "Working…" : "Clear models")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={removingModel !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRemovingModel(null);
        }}
      >
        <AlertDialogPopup initialFocus={cancelModelRemoval} bottomStickOnMobile={false}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('Delete model "{model}"?', {
                model: removingModel?.name ?? removingModel?.id ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "This removes the model from the local catalog. You can import it again if the service still lists it.",
              )}
            </AlertDialogDescription>
            {removalBlockers.length > 0 ? (
              <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {t(
                  "This model is selected or required by these agents: {agents}. Change their model bindings before deleting it.",
                  { agents: removalBlockers.join(", ") },
                )}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button ref={cancelModelRemoval} variant="outline" disabled={busy} />}
            >
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || !canRemoveModel}
              onClick={() => {
                if (!service || !removingModel || !canRemoveModel) return;
                void run(async () => {
                  const problem = commandError(
                    await update({
                      environmentId,
                      input: {
                        patch: {
                          modelServices: {
                            [id]: {
                              ...service,
                              models: models.filter((model) => model.id !== removingModel.id),
                            },
                          },
                        },
                      },
                    }),
                  );
                  if (!problem) {
                    if (modelEditor && modelEditor !== "new" && modelEditor.id === removingModel.id)
                      setModelEditor(null);
                    setRemovingModel(null);
                  }
                  return problem;
                });
              }}
            >
              {t(busy ? "Working…" : "Delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={bulkRemoval !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setBulkRemoval(null);
        }}
      >
        <AlertDialogPopup initialFocus={cancelBulkRemoval} bottomStickOnMobile={false}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                bulkRemoval?.kind === "failed"
                  ? bulkModels.length
                    ? bulkModels.length === 1
                      ? "Delete failed model?"
                      : "Delete {count} failed models?"
                    : "Review failed models ({count})"
                  : "Delete {count} unlisted models?",
                { count: bulkModels.length || (bulkRemoval?.kind === "failed" ? failed.size : 0) },
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                bulkRemoval?.kind === "failed"
                  ? bulkModels.length
                    ? "Delete only the models listed below from the local catalog. You can import them again if the service still lists them."
                    : "These models are required by agent bindings. Change the bindings before deleting them."
                  : "Only models no longer listed by the service will be removed from the local catalog. Manual models and models selected or required by agents are kept. Refreshing models can add them back if the service lists them again.",
              )}
            </AlertDialogDescription>
            {bulkModels.length > 0 ? (
              <ul
                aria-label={t("Models to delete")}
                className="max-h-48 overflow-y-auto rounded-md border border-border p-3 text-left text-xs"
              >
                {bulkModels.map((model) => (
                  <li key={model.id} className="break-all font-mono">
                    {model.id}
                  </li>
                ))}
              </ul>
            ) : null}
            {bulkPlan.protected.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  bulkRemoval?.kind === "failed" && bulkPlan.protected.length === 1
                    ? "Keeping one model required by an agent binding."
                    : "Keeping {count} models required by agent bindings.",
                  {
                    count: bulkPlan.protected.length,
                  },
                )}
              </p>
            ) : null}
            {bulkChanged || changed ? (
              <p role="alert" className="text-sm text-destructive">
                {t(
                  "The model catalog or connection changed. Close this dialog and review the cleanup again.",
                )}
              </p>
            ) : null}
            {!bulkModels.length && !bulkChanged && !changed && bulkRemoval?.kind === "unlisted" ? (
              <p role="alert" className="text-sm text-destructive">
                {t(
                  "No unlisted models can be deleted. They may have been refreshed or are required by agent bindings.",
                )}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              render={<Button ref={cancelBulkRemoval} variant="outline" disabled={busy} />}
            >
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy || readOnly || changed || bulkChanged || !bulkModels.length}
              onClick={() => {
                if (
                  !service ||
                  !bulkRemoval ||
                  readOnly ||
                  changed ||
                  bulkChanged ||
                  !bulkModels.length
                )
                  return;
                const removedIds = new Set(bulkModels.map((model) => model.id));
                void run(async () => {
                  const problem = commandError(
                    await update({
                      environmentId,
                      input: {
                        patch: {
                          modelServices: {
                            [id]: {
                              ...service,
                              models: models.filter((model) => !removedIds.has(model.id)),
                            },
                          },
                        },
                      },
                    }),
                  );
                  if (!problem) {
                    if (modelEditor && modelEditor !== "new" && removedIds.has(modelEditor.id))
                      setModelEditor(null);
                    setBulkRemoval(null);
                    setCleanupResult({ count: removedIds.size, kind: bulkRemoval.kind });
                    if (bulkRemoval.kind === "failed") tester.clear();
                  }
                  return problem;
                });
              }}
            >
              {t(busy ? "Working…" : "Delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {service && !readOnly ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 px-4 py-3 sm:px-5 lg:px-6">
          <p className="text-xs text-muted-foreground">
            {t("Bound agents: {count}", { count: bound })}
          </p>
          <Button
            size="touch"
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
  error,
  onCancel,
  onSave,
}: {
  readonly model: ModelServiceModel | undefined;
  readonly protocols: ReadonlyArray<ModelServiceProtocol>;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (model: ModelServiceModel) => void;
}) {
  const { t } = useTranslation();
  const [id, setId] = useState(model?.id ?? "");
  const [name, setName] = useState(model?.name ?? "");
  const [context, setContext] = useState(model?.capabilities?.contextWindow?.toString() ?? "");
  const [output, setOutput] = useState(model?.maxOutputTokens?.toString() ?? "");
  const [manualPrice, setManualPrice] = useState(model?.price !== undefined);
  const [priceFields, setPriceFields] = useState(() =>
    usagePriceForm("", model?.price ?? model?.modelsDevPrice),
  );
  const price = manualPrice ? parseUsagePriceForm({ ...priceFields, model: id })?.price : undefined;
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
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" && ["reasoningEffort", "effort", "thinking"].includes(option.id),
  );
  const reasoningDescriptor = descriptor?.type === "select" ? descriptor : undefined;
  const [reasoning, setReasoning] = useState(
    reasoningDescriptor?.options.map((option) => option.id).join(", ") ?? "",
  );
  const serviceTierDescriptor = model?.capabilities?.optionDescriptors?.find(
    (option) => option.id === "serviceTier" && option.type === "select",
  );
  const serviceTier = serviceTierDescriptor?.type === "select" ? serviceTierDescriptor : undefined;
  const [serviceTiers, setServiceTiers] = useState(
    serviceTier?.options.map((option) => option.id).join(", ") ?? "",
  );
  const [encryptedReasoningReplay, setEncryptedReasoningReplay] = useState<
    ModelServiceEncryptedReasoningReplay | undefined
  >(model?.encryptedReasoningReplay);
  const validNumber = (value: string) =>
    value === "" || (Number.isSafeInteger(Number(value)) && Number(value) > 0);
  return (
    <form
      aria-label={
        model ? t("Edit model {model}", { model: model.name ?? model.id }) : t("Add model")
      }
      className="min-w-0 space-y-3 rounded-lg border border-primary/30 bg-muted/20 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !id.trim() ||
          !validNumber(context) ||
          !validNumber(output) ||
          (defaults.length > 1 && !selected.length) ||
          (manualPrice && !price)
        )
          return;
        const levels = [...new Set(reasoning.split(/[,，\s]+/u).filter(Boolean))];
        const { currentValue, ...reasoningMetadata } = reasoningDescriptor ?? {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          currentValue: undefined,
        };
        const optionDescriptors = (model?.capabilities?.optionDescriptors ?? []).filter(
          (option) => option !== reasoningDescriptor && option !== serviceTierDescriptor,
        );
        const tiers = [...new Set(serviceTiers.split(/[,，\s]+/u).filter(Boolean))];
        if (tiers.length) {
          const { currentValue: tierValue, ...metadata } = serviceTier ?? {
            id: "serviceTier",
            label: "Service Tier",
            type: "select" as const,
            currentValue: undefined,
          };
          optionDescriptors.push({
            ...metadata,
            options: tiers.map(
              (id) =>
                serviceTier?.options.find((option) => option.id === id) ?? {
                  id,
                  label:
                    id === "priority" || id === "fast"
                      ? "Fast"
                      : id === "default"
                        ? "Standard"
                        : id,
                  ...(id === "default" ? { isDefault: true } : {}),
                },
            ),
            ...(tierValue && tiers.includes(tierValue) ? { currentValue: tierValue } : {}),
          });
        }
        if (levels.length) {
          optionDescriptors.push({
            ...reasoningMetadata,
            options: levels.map(
              (id) =>
                reasoningDescriptor?.options.find((option) => option.id === id) ?? {
                  id,
                  label: id,
                },
            ),
            ...(currentValue && levels.includes(currentValue) ? { currentValue } : {}),
          });
        }
        onSave({
          ...(encryptedReasoningReplay !== undefined ? { encryptedReasoningReplay } : {}),
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
          ...(defaults.length > 1 || model?.protocols ? { protocols: selected } : {}),
          capabilities: {
            ...model?.capabilities,
            ...(reasoningDescriptor || levels.length || serviceTier || tiers.length
              ? { optionDescriptors }
              : {}),
            contextWindow: context ? Number(context) : undefined,
            supportsImages: images === "unknown" ? undefined : images === "true",
          },
          ...(tools !== "unknown" ? { supportsTools: tools === "true" } : {}),
          ...(output ? { maxOutputTokens: Number(output) } : {}),
          ...(price ? { price } : {}),
          source: "manual",
        });
      }}
    >
      <h4 className="break-words text-sm font-medium">
        {model ? t("Edit model {model}", { model: model.name ?? model.id }) : t("Add model")}
      </h4>
      {error ? (
        <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      <label className="grid gap-1 text-sm">
        {t("Model ID")}
        <Input
          value={id}
          autoFocus
          onChange={(event) => setId(event.target.value)}
          required
          disabled={busy}
        />
      </label>
      <label className="grid gap-1 text-sm">
        {t("Display name")}
        <Input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{t("Token pricing")}</legend>
        <label className="grid gap-1 text-sm">
          {t("Price source")}
          <select
            aria-label={t("Price source")}
            className="min-h-11 min-w-0 rounded-md border border-input bg-background px-2"
            value={manualPrice ? "manual" : "models-dev"}
            disabled={busy}
            onChange={(event) => setManualPrice(event.target.value === "manual")}
          >
            <option value="models-dev">{t("Automatic from models.dev")}</option>
            <option value="manual">{t("Manual price")}</option>
          </select>
        </label>
        {manualPrice ? (
          <>
            <p className="text-xs text-muted-foreground">
              {t("USD per 1M tokens. Blank cache rates use the input rate.")}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {USAGE_PRICE_FIELDS.map(({ key }) => (
                <label className="grid gap-1 text-sm" key={key}>
                  {t(MODEL_PRICE_LABELS[key])}
                  <Input
                    inputMode="decimal"
                    disabled={busy}
                    value={priceFields[key]}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (isUsagePriceEdit(priceFields[key], value))
                        setPriceFields({ ...priceFields, [key]: value });
                    }}
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t(
              model?.modelsDevPrice && id.trim() === model.id
                ? "Uses the latest synced models.dev price."
                : "No models.dev price is currently available for this model.",
            )}
          </p>
        )}
      </fieldset>
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
      <div className="grid gap-1">
        <label className="grid gap-1 text-sm">
          {t("Reasoning levels")}
          <Input
            value={reasoning}
            onChange={(event) => setReasoning(event.target.value)}
            placeholder="low, medium, high, xhigh, max, ultra"
            disabled={busy}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {t("Comma-separated levels supported by this channel. Leave blank if unknown.")}
        </p>
      </div>
      <div className="grid gap-1">
        <label className="grid gap-1 text-sm">
          {t("Service tiers")}
          <Input
            value={serviceTiers}
            onChange={(event) => setServiceTiers(event.target.value)}
            placeholder="default, priority"
            disabled={busy}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {t(
            "Only enter tiers supported by this channel. priority or fast requests Fast routing; leave blank if unknown.",
          )}
        </p>
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
      <label className="grid gap-1 text-sm">
        {t("Model encrypted reasoning replay")}
        <select
          aria-label={t("Model encrypted reasoning replay")}
          className="min-h-10 min-w-0 rounded-md border border-input bg-background px-2"
          value={encryptedReasoningReplay ?? ""}
          disabled={busy}
          onChange={(event) =>
            setEncryptedReasoningReplay(
              event.target.value === "omit"
                ? "omit"
                : event.target.value === "preserve"
                  ? "preserve"
                  : undefined,
            )
          }
        >
          <option value="">{t("Use service setting")}</option>
          <option value="preserve">{t("Preserve encrypted reasoning")}</option>
          <option value="omit">{t("Omit encrypted reasoning")}</option>
        </select>
        <span className="text-xs text-muted-foreground">
          {t(
            "Overrides only this model's Responses replay policy. Saved conversation signatures are not modified.",
          )}
        </span>
      </label>
      {defaults.length > 1 ? (
        <fieldset disabled={busy} className="grid gap-1 sm:grid-cols-2">
          <legend className="text-sm">{t("Supported protocols")}</legend>
          {defaults.map((protocol) => (
            <label
              key={protocol}
              className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm"
            >
              <Checkbox
                checked={selected.includes(protocol)}
                onCheckedChange={(checked) =>
                  setSelected(
                    checked === true
                      ? [...selected, protocol]
                      : selected.filter((value) => value !== protocol),
                  )
                }
              />
              {MODEL_SERVICE_PROTOCOL_LABELS[protocol]}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={
            busy ||
            !id.trim() ||
            !validNumber(context) ||
            !validNumber(output) ||
            (manualPrice && !price) ||
            (defaults.length > 1 && !selected.length)
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
