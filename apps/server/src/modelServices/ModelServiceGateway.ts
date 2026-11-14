import {
  ModelServiceError,
  type ModelServiceBinding,
  type ModelServiceProtocol,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  ProviderSessionId,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  boundModelServiceModels,
  MODEL_SERVICE_AGENT_DRIVERS,
  modelServiceAgentProtocol,
  modelServiceAgentCapabilities,
  modelServiceModelSlug,
} from "@t3tools/shared/modelServices";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Pull from "effect/Pull";
import * as Settings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import { modelServiceEndpoint, modelServiceHeaders } from "./discovery.ts";
import { openProtocolBridge } from "./ProtocolBridge.ts";
import { modelServiceUpstreamProtocol } from "./upstreamProtocol.ts";
import { makeModelServiceStreamMonitor, ModelServiceStreamError } from "./streamIntegrity.ts";
import { chatResponseOutput } from "./responseOutput.ts";
import {
  modelServiceRequestBody,
  modelServiceRequestOutputBudget,
  withoutEncryptedReasoning,
  withoutForcedToolThinking,
  withoutForcedToolChoice,
} from "./requestCompatibility.ts";
import {
  parseUpstreamError,
  upstreamErrorDetails,
  upstreamContextOverflow,
} from "./upstreamError.ts";
import {
  modelServiceHasReasoning,
  modelServiceStreamEvent,
  modelServiceResponseIsValid,
} from "./responseProgress.ts";
import {
  ModelServiceRequestFailure,
  ModelServiceRequestCancelled,
  recoverModelServiceRequest,
  retryAfterMilliseconds,
  isRetryableModelServiceError,
  type ModelServiceRecoveryLoad,
} from "./recovery.ts";
import { makeRecoveryTracker } from "./recoveryTracker.ts";
import { ChildProcessSpawner } from "effect/process";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServer,
  HttpServerResponse,
} from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as ByteSize from "effect/ByteSize";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const API_NAMES: Record<ModelServiceProtocol, string> = {
  "openai-chat": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
  gemini: "google-generative-ai",
};
const SDK_PACKAGES: Record<ModelServiceProtocol, string> = {
  "openai-chat": "@ai-sdk/openai-compatible",
  "openai-responses": "@ai-sdk/openai",
  "anthropic-messages": "@ai-sdk/anthropic",
  gemini: "@ai-sdk/google",
};
const FORCED_TOOL_CHOICE_REJECTING_MODEL_ID =
  /^claude-(?:(?:fable|mythos)(?:-|$)|(?:opus|sonnet)-5[.-]5(?:[.-]|$))/i;
const PREFIX = "/api/model-gateway";
const isModelServiceError = Schema.is(ModelServiceError);
const ZERO_TOKEN_STOP_CODE = "cox_model_service_zero_token_stop";
const ZERO_TOKEN_STOP_MESSAGE =
  "The model service completed without generating any content, reasoning or tool calls and reported zero output tokens. Check the service's history reasoning replay compatibility before trying again.";
const incomingProtocol = (pathname: string): ModelServiceProtocol | undefined =>
  pathname === PREFIX + "/v1/responses"
    ? "openai-responses"
    : pathname === PREFIX + "/v1/chat/completions"
      ? "openai-chat"
      : pathname === PREFIX + "/v1/messages" || pathname === PREFIX + "/v1/messages/count_tokens"
        ? "anthropic-messages"
        : /^\/api\/model-gateway\/v1beta\/models\/.+:(?:streamGenerateContent|generateContent)$/.test(
              pathname,
            )
          ? "gemini"
          : undefined;
const gatewayErrorResponse = (
  incoming: ModelServiceProtocol | undefined,
  status: number,
  error: Readonly<Record<string, unknown>>,
) => {
  const type =
    status === 400 || status === 422
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status === 413
              ? "request_too_large"
              : status === 429
                ? "rate_limit_error"
                : status === 529
                  ? "overloaded_error"
                  : "api_error";
  const googleStatus =
    status === 400 || status === 413 || status === 422
      ? "INVALID_ARGUMENT"
      : status === 401
        ? "UNAUTHENTICATED"
        : status === 403
          ? "PERMISSION_DENIED"
          : status === 404
            ? "NOT_FOUND"
            : status === 429
              ? "RESOURCE_EXHAUSTED"
              : status === 499
                ? "CANCELLED"
                : status === 503 || status === 529
                  ? "UNAVAILABLE"
                  : status === 504
                    ? "DEADLINE_EXCEEDED"
                    : "INTERNAL";
  return HttpServerResponse.jsonUnsafe(
    incoming === "anthropic-messages"
      ? { type: "error", error: { ...error, type } }
      : incoming === "gemini"
        ? {
            error: {
              ...error,
              ...(error.code ? { diagnosticCode: error.code } : {}),
              code: status,
              status: googleStatus,
            },
          }
        : { error: { type, ...error } },
    { status, headers: { "x-should-retry": "false" } },
  );
};
const recoveryFailureResponse = (
  incoming: ModelServiceProtocol | undefined,
  error: ModelServiceRequestFailure,
) =>
  gatewayErrorResponse(incoming, error.status, {
    message: error.detail,
    code: error.code ?? "cox_model_service_recovery_exhausted",
    source: error.source,
    requestId: error.requestId,
    terminationReason: error.terminationReason,
    budgetMs: error.budgetMs,
    elapsedMs: error.elapsedMs,
    attempts: error.attempts,
    lastAttemptFailure: error.lastAttemptFailure,
  });

interface RuntimeBinding {
  readonly token: string;
  readonly binding: ModelServiceBinding;
  readonly driver: string;
}

export class ModelServiceGateway extends Context.Service<
  ModelServiceGateway,
  {
    readonly lifecycle?: ReturnType<typeof makeRecoveryTracker>;
    readonly materialize: (
      settings: ServerSettings,
      instances: ProviderInstanceConfigMap,
    ) => Effect.Effect<ProviderInstanceConfigMap, ModelServiceError>;
    readonly handle: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest | import("effect/Scope").Scope
    >;
  }
>()("cox/modelServices/ModelServiceGateway") {}

export const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bindings = new Map<ProviderInstanceId, RuntimeBinding>();
  const loads = new Map<string, ModelServiceRecoveryLoad>();
  const lifecycle = makeRecoveryTracker();
  const server = yield* Effect.serviceOption(HttpServer.HttpServer);
  const origin = Option.isSome(server)
    ? HttpServer.formatAddress(server.value.address)
    : `http://${config.host === "::1" ? "[::1]" : "127.0.0.1"}:${config.port}`;
  const baseUrl = origin.replace(/\/+$/, "") + PREFIX;
  const write = Effect.fn("ModelServiceGateway.writeRuntimeFile")(function* (
    file: string,
    value: unknown,
  ) {
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const text = yield* encode(value);
    const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    if (text === previous) return;
    const temporary = file + ".next";
    yield* fs.writeFileString(temporary, text, { mode: 0o600 });
    yield* fs.rename(temporary, file);
  });
  const materialize = Effect.fn("ModelServiceGateway.materialize")(
    function* (current: ServerSettings, instances: ProviderInstanceConfigMap) {
      const next = { ...instances };
      for (const id of bindings.keys()) if (!instances[id]?.modelService) bindings.delete(id);
      for (const [rawId, instance] of Object.entries(instances)) {
        const binding = instance.modelService;
        if (!binding) continue;
        const id = rawId as ProviderInstanceId;
        if (instance.enabled === false || record(instance.config).enabled === false) {
          bindings.delete(id);
          continue;
        }
        const service = current.modelServices[binding.serviceId];
        if (
          !service ||
          !(MODEL_SERVICE_AGENT_DRIVERS as ReadonlyArray<string>).includes(instance.driver)
        )
          return yield* new ModelServiceError({
            detail: "The agent's model service is missing or unsupported.",
          });
        const models = boundModelServiceModels(service, binding);
        const activeModels = models.filter((model) => model.available !== false);
        const unavailableRole =
          instance.driver === "omo" &&
          [record(instance.config).agentModels, record(instance.config).categoryModels].some(
            (roleModels) =>
              Object.values(record(roleModels)).some(
                (slug) =>
                  slug !== "" &&
                  (typeof slug !== "string" ||
                    !activeModels.some((model) => `cox/${model.id}` === slug)),
              ),
          );
        if (activeModels.length === 0 || unavailableRole) {
          bindings.delete(id);
          next[id] = {
            ...instance,
            enabled: false,
            config: { ...record(instance.config), enabled: false },
          };
          continue;
        }
        const selected =
          activeModels.find((model) => model.id === binding.defaultModel)?.id ??
          activeModels[0]!.id;
        const prior = bindings.get(id);
        const token =
          prior?.binding.serviceId === binding.serviceId
            ? prior.token
            : yield* crypto.randomUUIDv4();
        bindings.set(id, { token, binding, driver: instance.driver });
        const native = record(instance.config);
        const protocol = modelServiceAgentProtocol(instance.driver, service);
        const multiProtocol = new Set(service.protocols).size > 1;
        const directory = path.join(config.baseDir, "model-services", "runtime", id);
        const runtimeModels = activeModels.map((model) => ({
          slug: modelServiceModelSlug(instance.driver, model.id),
          name: model.name ?? model.id,
          ...(model.capabilities
            ? { capabilities: modelServiceAgentCapabilities(instance.driver, model.capabilities) }
            : {}),
        }));
        const environment = [...(instance.environment ?? [])].filter(
          (variable) =>
            variable.name !== "COX_MODEL_SERVICE_KEY" &&
            !(
              instance.driver === "claudeAgent" && variable.name === "CLAUDE_CODE_MAX_OUTPUT_TOKENS"
            ) &&
            !(instance.driver === "omo" && variable.name === "COX_OMO_GATEWAY_TIMEOUT_MS"),
        );
        environment.push({ name: "COX_MODEL_SERVICE_KEY", value: token, sensitive: true });
        if (instance.driver === "claudeAgent") {
          const maxOutputTokens = activeModels.find(
            (model) => model.id === selected,
          )?.maxOutputTokens;
          if (maxOutputTokens)
            environment.push({
              name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
              value: String(maxOutputTokens),
              sensitive: false,
            });
          environment.push({ name: "CLAUDE_CODE_MAX_RETRIES", value: "0", sensitive: false });
          environment.push({
            name: "API_TIMEOUT_MS",
            value: String(service.recovery.budgetMs + 30_000),
            sensitive: false,
          });
        }
        const additions: Record<string, unknown> = { customModels: runtimeModels };
        if (instance.driver === "codex" || instance.driver === "claudeAgent") {
          additions.baseUrl = baseUrl + "/v1";
          additions.apiKey = token;
        }
        if (instance.driver === "codex") {
          const catalog = path.join(directory, "codex-models.json");
          yield* write(catalog, {
            models: models.map((model, index) => {
              const descriptors = modelServiceAgentCapabilities(
                "codex",
                model.capabilities,
              )?.optionDescriptors;
              const reasoning = descriptors?.find(
                (descriptor) => descriptor.id === "reasoningEffort",
              );
              const speed = descriptors?.find((descriptor) => descriptor.id === "serviceTier");
              const tiers =
                speed?.type === "select"
                  ? speed.options.filter((option) => option.id !== "default")
                  : [];
              const levels = reasoning?.type === "select" ? reasoning.options : [];
              return {
                slug: model.id,
                display_name: model.name ?? model.id,
                description: model.name ?? model.id,
                default_reasoning_level:
                  levels.find((option) => option.isDefault)?.id ?? levels[0]?.id ?? null,
                supported_reasoning_levels: levels.map((option) => ({
                  effort: option.id,
                  description: option.label,
                })),
                ...(tiers.length
                  ? {
                      service_tiers: tiers.map((tier) => ({
                        id: tier.id,
                        name: tier.label,
                        description: tier.description ?? "",
                      })),
                      default_service_tier:
                        speed?.type === "select"
                          ? (speed.currentValue ??
                            speed.options.find((option) => option.isDefault)?.id ??
                            null)
                          : null,
                    }
                  : {}),
                shell_type: "shell_command",
                visibility: model.available === false ? "hide" : "list",
                supported_in_api: true,
                priority: index,
                availability_nux: null,
                upgrade: null,
                model_messages: null,
                base_instructions:
                  "You are a coding agent. Follow the user's instructions and use the available tools to complete the task.",
                include_skills_usage_instructions: true,
                include_plugin_usage_instructions: true,
                include_apps_usage_instructions: false,
                supports_reasoning_summary_parameter: false,
                default_reasoning_summary: "none",
                support_verbosity: false,
                default_verbosity: null,
                apply_patch_tool_type: null,
                web_search_tool_type: "text",
                truncation_policy: { mode: "tokens", limit: 10000 },
                ...(model.capabilities?.contextWindow
                  ? {
                      context_window: model.capabilities.contextWindow,
                      max_context_window: model.capabilities.contextWindow,
                    }
                  : {}),
                effective_context_window_percent: 95,
                experimental_supported_tools: [],
                input_modalities: model.capabilities?.supportsImages ? ["text", "image"] : ["text"],
                supports_search_tool: false,
                supports_experimental_context: false,
              };
            }),
          });
          const catalogArgument = yield* encode(`model_catalog_json=${yield* encode(catalog)}`);
          const modelArgument = yield* encode(`model=${yield* encode(selected)}`);
          additions.launchArgs = `${typeof native.launchArgs === "string" ? native.launchArgs : ""} -c ${catalogArgument} -c ${modelArgument}`;
        }
        if (instance.driver === "claudeAgent") {
          for (const name of [
            "ANTHROPIC_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          ])
            environment.push({ name, value: selected, sensitive: false });
        }
        if (instance.driver === "pi" || instance.driver === "omo") {
          const agentDir = path.join(directory, instance.driver);
          {
            const settingsPath = path.join(agentDir, "settings.json");
            const runtimeSettingsText = (yield* fs.exists(settingsPath))
              ? yield* fs.readFileString(settingsPath)
              : "{}";
            const existing = record(yield* decode(runtimeSettingsText));
            const retry = record(existing.retry);
            const timeoutMs = service.recovery.budgetMs + 30_000;
            if (instance.driver === "omo")
              environment.push({
                name: "COX_OMO_GATEWAY_TIMEOUT_MS",
                value: String(timeoutMs),
                sensitive: false,
              });
            yield* write(settingsPath, {
              ...existing,
              httpIdleTimeoutMs: timeoutMs,
              retry: {
                ...retry,
                enabled: false,
                ...(instance.driver === "pi" ? { maxRetries: 0 } : {}),
                provider: {
                  ...record(retry.provider),
                  ...(instance.driver === "pi"
                    ? { maxRetries: 0 }
                    : { streamStartTimeoutMs: timeoutMs, keepAliveTimeoutMs: timeoutMs }),
                  timeoutMs,
                },
              },
            });
          }
          yield* write(path.join(agentDir, "models.json"), {
            providers: {
              cox: {
                baseUrl:
                  protocol === "anthropic-messages"
                    ? baseUrl
                    : baseUrl + (protocol === "gemini" ? "/v1beta" : "/v1"),
                api: API_NAMES[protocol],
                apiKey: "$COX_MODEL_SERVICE_KEY",
                ...(protocol === "openai-responses" && !multiProtocol
                  ? { compat: { supportsStrictMode: true } }
                  : {}),
                models: activeModels.map((model) => {
                  const nativeProtocol = multiProtocol
                    ? (modelServiceUpstreamProtocol(service, model, protocol) ?? protocol)
                    : protocol;
                  const thinking = modelServiceAgentCapabilities(
                    instance.driver,
                    model.capabilities,
                  )?.optionDescriptors?.[0];
                  const levels = thinking?.type === "select" ? thinking.options : [];
                  return {
                    id: model.id,
                    name: model.name ?? model.id,
                    ...(multiProtocol
                      ? {
                          api: API_NAMES[nativeProtocol],
                          baseUrl:
                            nativeProtocol === "anthropic-messages"
                              ? baseUrl
                              : baseUrl + (nativeProtocol === "gemini" ? "/v1beta" : "/v1"),
                        }
                      : {}),
                    ...(levels.length
                      ? {
                          reasoning: true,
                          thinkingLevelMap: Object.fromEntries(
                            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
                              (level) => [
                                level,
                                levels.some((option) => option.id === level)
                                  ? level === "off"
                                    ? "none"
                                    : level
                                  : null,
                              ],
                            ),
                          ),
                        }
                      : {}),
                    ...(model.capabilities?.contextWindow
                      ? { contextWindow: model.capabilities.contextWindow }
                      : {}),
                    ...(model.maxOutputTokens ? { maxTokens: model.maxOutputTokens } : {}),
                    ...(model.capabilities?.supportsImages ? { input: ["text", "image"] } : {}),
                    ...(nativeProtocol === "openai-responses" && multiProtocol
                      ? { compat: { supportsStrictMode: true } }
                      : nativeProtocol !== "gemini" &&
                          FORCED_TOOL_CHOICE_REJECTING_MODEL_ID.test(model.id.split("/").at(-1)!)
                        ? { compat: { supportsForcedToolChoice: false } }
                        : {}),
                  };
                }),
              },
            },
          });
          Object.assign(additions, {
            agentDir,
            sessionDir: path.join(agentDir, "sessions"),
            provider: "cox",
            model: selected,
            apiKey: "",
            ...(instance.driver === "omo" ? { modelServiceManaged: true } : {}),
          });
        }
        if (instance.driver === "opencode") {
          const opencode = {
            provider: {
              cox: {
                name: service.name,
                npm: SDK_PACKAGES[protocol],
                options: {
                  baseURL: baseUrl + (!multiProtocol && protocol === "gemini" ? "/v1beta" : "/v1"),
                  apiKey: token,
                },
                models: Object.fromEntries(
                  activeModels.map((model) => {
                    const nativeProtocol = multiProtocol
                      ? (modelServiceUpstreamProtocol(service, model, protocol) ?? protocol)
                      : protocol;
                    return [
                      model.id,
                      {
                        name: model.name ?? model.id,
                        ...(multiProtocol
                          ? {
                              provider: { npm: SDK_PACKAGES[nativeProtocol] },
                            }
                          : {}),
                        ...(model.capabilities?.contextWindow
                          ? {
                              limit: {
                                context: model.capabilities.contextWindow,
                                output:
                                  model.maxOutputTokens ??
                                  Math.min(model.capabilities.contextWindow, 32_000),
                              },
                            }
                          : {}),
                      },
                    ];
                  }),
                ),
              },
            },
            enabled_providers: ["cox"],
            model: `cox/${selected}`,
            small_model: `cox/${selected}`,
          };
          environment.push({
            name: "OPENCODE_CONFIG_CONTENT",
            value: yield* encode(opencode),
            sensitive: true,
          });
          additions.serverUrl = "";
        }
        next[id] = { ...instance, environment, config: { ...native, ...additions } };
      }
      return next;
    },
    Effect.mapError((error) =>
      isModelServiceError(error)
        ? error
        : new ModelServiceError({
            detail: "Could not prepare the agent's model service configuration.",
          }),
    ),
  );

  const handle = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = new URL(request.url, "http://127.0.0.1");
    const countTokens = url.pathname === PREFIX + "/v1/messages/count_tokens";
    const incoming = incomingProtocol(url.pathname);
    const token =
      request.headers.authorization?.replace(/^Bearer /i, "") ??
      request.headers["x-api-key"] ??
      request.headers["x-goog-api-key"];
    const runtime = token
      ? [...bindings.values()].find((entry) => entry.token === token.split(".")[0])
      : undefined;
    if (!runtime || request.headers.origin)
      return gatewayErrorResponse(incoming, 401, {
        message: "Model gateway authentication required.",
      });
    const service = (yield* settings.getSettings).modelServices[runtime.binding.serviceId];
    const sessionId = token?.slice(runtime.token.length + 1);
    if (!service?.enabled)
      return gatewayErrorResponse(incoming, 503, {
        message: "This model service is unavailable.",
      });
    const models = boundModelServiceModels(service, runtime.binding);
    if (request.method === "GET" && url.pathname === PREFIX + "/v1/models")
      return HttpServerResponse.jsonUnsafe({
        object: "list",
        data: models
          .filter((model) => model.available !== false)
          .map((model) => ({
            id: model.id,
            object: "model",
            display_name: model.name ?? model.id,
            context_window: model.capabilities?.contextWindow,
            supports_images: model.capabilities?.supportsImages,
          })),
        has_more: false,
      });
    if (!incoming || request.method !== "POST")
      return gatewayErrorResponse(incoming, 404, { message: "Model gateway route not found." });
    if (Number(request.headers["content-length"]) > 16 * 1024 * 1024)
      return gatewayErrorResponse(incoming, 413, {
        message: "Model service request body is too large.",
        code: "request_too_large",
      });
    const body = record(
      yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(16 * 1024 * 1024)),
        Effect.mapError(
          () =>
            new ModelServiceError({ detail: "Invalid model service request body.", status: 400 }),
        ),
      ),
    );
    const requestId = yield* crypto.randomUUIDv4();
    const tracking = lifecycle.request(
      sessionId ? ProviderSessionId.make(sessionId) : undefined,
      requestId,
    );
    const googleId =
      incoming === "gemini"
        ? decodeURIComponent(
            url.pathname
              .slice((PREFIX + "/v1beta/models/").length)
              .replace(/:(?:streamGenerateContent|generateContent)$/, ""),
          )
        : undefined;
    const requested = googleId ?? (typeof body.model === "string" ? body.model : "");
    const selected = models.find(
      (model) =>
        model.id === requested || (incoming === "gemini" && model.id === `models/${requested}`),
    );
    if (!selected)
      return gatewayErrorResponse(incoming, 403, {
        message: "This model is not allowed by the agent binding.",
      });
    if (selected.available === false)
      return gatewayErrorResponse(incoming, 503, {
        message:
          "This model is no longer advertised by the model service. Refresh its catalog or select another model.",
      });
    const protocol = modelServiceUpstreamProtocol(service, selected, incoming);
    if (!protocol)
      return gatewayErrorResponse(incoming, 422, {
        message:
          "No compatible upstream protocol is configured for this model. Multi-protocol services require OpenAI Responses for GPT models, OpenAI Chat for Kimi models, and Anthropic Messages for other models.",
      });
    if (countTokens && protocol !== incoming)
      return yield* new ModelServiceError({
        detail: "Token counting is unavailable across different model protocols.",
        status: 501,
      });
    const stream =
      body.stream === true ||
      (incoming === "gemini" && url.pathname.endsWith(":streamGenerateContent"));
    const load = loads.get(runtime.binding.serviceId) ?? {
      inFlight: 0,
      hedges: 0,
      cooldownUntil: 0,
    };
    loads.set(runtime.binding.serviceId, load);
    const enabled = settings.getSettings.pipe(
      Effect.map(
        (current) =>
          current.modelServices[runtime.binding.serviceId]?.enabled === true &&
          [...bindings.values()].some(
            (entry) =>
              entry.token === runtime.token &&
              entry.binding.serviceId === runtime.binding.serviceId,
          ),
      ),
      Effect.orElseSucceed(() => false),
    );
    const diagnostic = (event: Readonly<Record<string, unknown>>) =>
      Effect.logInfo("Model gateway recovery", {
        requestId,
        sessionId,
        ...tracking.context,
        incoming,
        protocol,
        ...event,
      });
    let hasEncryptedReasoning = false;
    const replayPolicy =
      selected.encryptedReasoningReplay ?? service.encryptedReasoningReplay ?? "preserve";
    let omitEncryptedReasoning = replayPolicy === "omit";
    let disableForcedToolThinking = false;
    let canRepairForcedToolThinking = false;
    let relaxForcedToolChoice = false;
    let canRepairForcedToolChoice = false;
    const rejectedFailure = (
      status: number,
      value: unknown,
      fallbackCode: string,
      message: string,
      headers: Readonly<Record<string, string | undefined>>,
    ) => {
      const error = parseUpstreamError(value);
      const overflow = upstreamContextOverflow(error);
      const details = upstreamErrorDetails(
        error,
        headers["x-request-id"] ?? headers["request-id"],
        [service.apiKey ?? "", ...Object.values(service.headers), runtime.token],
      );
      return new ModelServiceRequestFailure({
        detail: overflow
          ? incoming === "anthropic-messages"
            ? overflow.tokens !== undefined && overflow.limit !== undefined
              ? `prompt is too long: ${overflow.tokens} tokens > ${overflow.limit} maximum`
              : "prompt is too long"
            : incoming === "gemini"
              ? "The input token count exceeds the maximum number of tokens allowed."
              : "The request exceeds the model's maximum context length."
          : message + details.detail,
        status: overflow ? 400 : status,
        retryable:
          !overflow &&
          details.code !== "invalid_encrypted_content" &&
          isRetryableModelServiceError(status, {
            ...error,
            ...(details.code ? { code: details.code } : {}),
          }),
        code: overflow ? "context_length_exceeded" : (details.code ?? fallbackCode),
        source: "upstream",
        requestId: details.requestId,
      });
    };
    const initialBridge =
      protocol === incoming
        ? undefined
        : yield* openProtocolBridge({
            from: incoming,
            to: protocol,
            model: selected.id,
            stream,
            body,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
    const attempt = Effect.fn("ModelServiceGateway.attempt")(
      function* (attemptId: number) {
        const stripEncryptedReasoning = omitEncryptedReasoning;
        const stripForcedToolThinking = disableForcedToolThinking;
        const useAutoToolChoice = relaxForcedToolChoice;
        const started = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({ requestId, attempt: attemptId, incoming, protocol });
        const bridge =
          attemptId === 1
            ? initialBridge
            : protocol === incoming
              ? undefined
              : yield* openProtocolBridge({
                  from: incoming,
                  to: protocol,
                  model: selected.id,
                  stream,
                  body,
                }).pipe(
                  Effect.provideService(FileSystem.FileSystem, fs),
                  Effect.provideService(Path.Path, path),
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                );
        if (
          bridge?.replay &&
          (bridge.replay.opaqueItemsOmitted > 0 || bridge.replay.unavailableFieldsOmitted > 0)
        )
          yield* diagnostic({
            event: "request_compatibility",
            attempt: attemptId,
            action: "omitted_unavailable_reasoning_replay",
            ...bridge.replay,
          });
        const endpoint =
          protocol === "openai-responses"
            ? "responses"
            : protocol === "openai-chat"
              ? "chat/completions"
              : protocol === "anthropic-messages"
                ? countTokens
                  ? "messages/count_tokens"
                  : "messages"
                : `models/${encodeURIComponent(selected.id.replace(/^models\//, ""))}:${stream ? "streamGenerateContent" : "generateContent"}`;
        const upstreamUrl = modelServiceEndpoint(service, protocol, endpoint);
        if (protocol === "gemini" && stream) upstreamUrl.searchParams.set("alt", "sse");
        const headers = modelServiceHeaders(service, protocol);
        if (protocol === "anthropic-messages" && request.headers["anthropic-beta"])
          headers["anthropic-beta"] = [
            ...new Set(
              [headers["anthropic-beta"], request.headers["anthropic-beta"]].flatMap(
                (value) =>
                  value
                    ?.split(",")
                    .map((beta) => beta.trim())
                    .filter(Boolean) ?? [],
              ),
            ),
          ].join(",");
        const budget = countTokens
          ? { body }
          : modelServiceRequestOutputBudget(
              protocol,
              selected.id,
              bridge ? record(bridge.body) : body,
              selected.maxOutputTokens,
              bridge ? { protocol: incoming, body } : undefined,
            );
        if (budget.error)
          return yield* new ModelServiceError({ detail: budget.error, status: 400 });
        if (budget.field)
          yield* diagnostic({
            event: "request_compatibility",
            attempt: attemptId,
            action: "output_budget_defaulted",
            model: selected.id,
            field: budget.field,
            value: selected.maxOutputTokens,
            source: "model_metadata",
          });
        let requestBody = modelServiceRequestBody(protocol, selected.id, budget.body);
        if (protocol === "openai-chat") {
          const automatic = withoutForcedToolChoice(requestBody);
          canRepairForcedToolChoice ||= automatic !== requestBody;
          if (useAutoToolChoice) requestBody = automatic;
        }
        if (protocol === "openai-chat" || protocol === "anthropic-messages") {
          const forced = record(requestBody.tool_choice).type;
          const repaired =
            protocol === "anthropic-messages"
              ? record(requestBody.thinking).type === "enabled" &&
                (forced === "any" || forced === "tool")
                ? Object.fromEntries(
                    Object.entries(requestBody).filter(([key]) => key !== "thinking"),
                  )
                : requestBody
              : withoutForcedToolThinking(requestBody);
          canRepairForcedToolThinking ||= repaired !== requestBody;
          if (stripForcedToolThinking) {
            requestBody = repaired;
            yield* diagnostic({
              event: "request_compatibility",
              attempt: attemptId,
              action: "disabled_thinking_for_forced_tool",
              reason: "incompatible_tool_choice_thinking",
            });
          }
        }
        if (protocol === "openai-responses") {
          const cleaned = withoutEncryptedReasoning(requestBody);
          hasEncryptedReasoning ||= cleaned !== requestBody;
          if (stripEncryptedReasoning) {
            if (cleaned !== requestBody)
              yield* diagnostic({
                event: "request_compatibility",
                attempt: attemptId,
                action: "removed_encrypted_reasoning",
                reason: replayPolicy === "omit" ? "configured_omit" : "invalid_encrypted_content",
              });
            requestBody = cleaned;
          }
        }
        const outgoing = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(upstreamUrl.href).pipe(HttpClientRequest.setHeaders(headers)),
          requestBody,
        );
        const headersStarted = yield* Clock.currentTimeMillis;
        const response = yield* HttpClient.withScope(http)
          .execute(outgoing)
          .pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.timeoutOrElse({
              duration: service.recovery.responseHeadersTimeoutMs,
              orElse: () =>
                Effect.fail(
                  new ModelServiceRequestFailure({
                    detail: `The model service did not return response headers within ${service.recovery.responseHeadersTimeoutMs} ms.`,
                    status: 504,
                    retryable: true,
                    code: "upstream_response_headers_timeout",
                    source: "gateway",
                    timeoutMs: service.recovery.responseHeadersTimeoutMs,
                  }),
                ),
            }),
          );
        yield* diagnostic({
          event: "response_headers",
          attempt: attemptId,
          status: response.status,
          elapsedMs: (yield* Clock.currentTimeMillis) - headersStarted,
        });
        if (response.status < 200 || response.status >= 300) {
          let errorBytes = 0;
          const rejected = yield* response.stream.pipe(
            Stream.takeUntil(
              (chunk) => {
                errorBytes += chunk.length;
                return errorBytes > 16384;
              },
              { excludeLast: true },
            ),
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (body, chunk) => body + chunk,
            ),
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))),
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => ({})),
          );
          const failure = rejectedFailure(
            response.status >= 400 && response.status < 600 ? response.status : 502,
            rejected,
            "upstream_http_error",
            `The upstream model service returned HTTP ${response.status}.`,
            response.headers,
          );
          return yield* new ModelServiceRequestFailure({
            ...failure,
            retryAfterMs: retryAfterMilliseconds(
              response.headers["retry-after"],
              yield* Clock.currentTimeMillis,
            ),
          });
        }
        if (stream) {
          const upstream = makeModelServiceStreamMonitor(protocol);
          const preview = makeModelServiceStreamMonitor(protocol);
          const downstream = makeModelServiceStreamMonitor(incoming);
          const convertedMonitor = bridge ? makeModelServiceStreamMonitor(incoming) : undefined;
          let selectedResponse = false;
          let upstreamEof = false;
          let bridgeFrames = 0;
          let bridgeFinishAttempted = false;
          let convertedFinalized = false;
          let downstreamEnded = false;
          let downstreamBytes = 0;
          let errorEmitted = false;
          let upstreamErrorCode: string | undefined;
          let outcome = "not_consumed";
          let failureStage: "upstream" | "bridge" | "downstream" | undefined;
          let downstreamExit = "not_started";
          let zeroTokenStopDetected = false;
          const integrityError = (error: unknown) =>
            error instanceof ModelServiceStreamError
              ? error
              : new ModelServiceStreamError({
                  reason: "invalid_stream_event",
                  detail: "The model service sent an invalid stream event.",
                });
          const upstreamRequestId = upstreamErrorDetails(
            {},
            response.headers["x-request-id"] ?? response.headers["request-id"],
            [service.apiKey ?? "", ...Object.values(service.headers), runtime.token],
          ).requestId;
          yield* Effect.addFinalizer((exit) =>
            Effect.gen(function* () {
              if (outcome === "not_consumed" && (yield* tracking.cancelled))
                outcome = "request_cancelled";
              if (outcome === "not_consumed" && !(yield* enabled)) outcome = "service_disabled";
              if (
                outcome === "not_consumed" &&
                Exit.isFailure(exit) &&
                Cause.hasInterrupts(exit.cause)
              )
                outcome = selectedResponse ? "downstream_interrupted" : "attempt_interrupted";
              if (selectedResponse && outcome === "not_consumed") outcome = "downstream_stopped";
              if (outcome === "not_consumed") outcome = "attempt_stopped_before_selection";
              yield* diagnostic({
                event: "stream_terminal",
                attempt: attemptId,
                selectedResponse,
                outcome,
                failureStage,
                upstreamRequestId,
                upstreamEof,
                upstream: selectedResponse ? upstream.snapshot() : preview.snapshot(),
                converted: bridge !== undefined,
                bridgeFrames,
                bridgeFinishAttempted,
                convertedFinalized,
                bridge: convertedMonitor?.snapshot(),
                bridgeState: bridge?.snapshot(),
                downstream: downstream.snapshot(),
                downstreamBytes,
                downstreamEnded,
                errorEmitted,
                downstreamExit,
                zeroTokenStopDetected,
                delivery: "network_receipt_unconfirmed",
              });
            }),
          );
          const checked = <A, E, R>(
            stage: NonNullable<typeof failureStage>,
            effect: Effect.Effect<A, E, R>,
          ) =>
            effect.pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  failureStage = stage;
                  outcome =
                    error instanceof ModelServiceStreamError ? error.reason : `${stage}_error`;
                }),
              ),
            );
          const rawPull = yield* Stream.toPull(response.stream);
          const pending: Uint8Array[] = [];
          let buffered = 0;
          let progress = false;
          while (!progress) {
            const chunks = yield* rawPull.pipe(
              Pull.catchDone(() =>
                Effect.gen(function* () {
                  upstreamEof = true;
                  outcome = "ended_before_output";
                  yield* checked(
                    "upstream",
                    Effect.try({ try: () => preview.finish(), catch: integrityError }),
                  );
                  return yield* new ModelServiceRequestFailure({
                    detail: "The model service stream ended before producing a usable response.",
                    status: 502,
                    retryable: true,
                    code: "upstream_stream_ended_before_output",
                    source: "upstream",
                  });
                }),
              ),
              Effect.tapError(() =>
                Effect.sync(() => {
                  failureStage = "upstream";
                  if (outcome === "not_consumed") outcome = "upstream_transport_error";
                }),
              ),
            );
            for (const chunk of chunks) {
              pending.push(chunk);
              buffered += chunk.length;
              if (buffered > 1024 * 1024) {
                outcome = "preview_limit";
                failureStage = "upstream";
                return yield* new ModelServiceRequestFailure({
                  detail:
                    "The model service sent too much data before producing a usable response.",
                  status: 502,
                  retryable: false,
                  code: "gateway_preview_limit",
                  source: "gateway",
                });
              }
              const frames = yield* checked(
                "upstream",
                Effect.try({ try: () => preview.push(chunk), catch: integrityError }),
              );
              for (const frame of frames) {
                const event = modelServiceStreamEvent(protocol, frame);
                if (event.error) {
                  outcome = "upstream_error";
                  failureStage = "upstream";
                  const error = parseUpstreamError(event.error);
                  const details = upstreamErrorDetails(error);
                  const status = Number(error.status ?? error.code);
                  const retryable = isRetryableModelServiceError(
                    status >= 400 && status < 600 ? status : 502,
                    { ...error, ...(details.code ? { code: details.code } : {}) },
                  );
                  return yield* rejectedFailure(
                    details.code === "invalid_encrypted_content"
                      ? 400
                      : status >= 400 && status < 600
                        ? status
                        : retryable
                          ? 502
                          : 400,
                    error,
                    "upstream_stream_error",
                    "The model service returned a stream error before producing a usable response.",
                    response.headers,
                  );
                }
                progress ||= event.progress;
              }
            }
          }
          yield* diagnostic({
            event: "first_usable_output",
            attempt: attemptId,
            elapsedMs: (yield* Clock.currentTimeMillis) - started,
          });
          selectedResponse = true;
          const source = Stream.concat(
            Stream.fromIterable(pending),
            Stream.fromPull(Effect.succeed(rawPull)),
          ).pipe(
            Stream.onError((cause) =>
              Effect.sync(() => {
                if (failureStage === undefined && !Cause.hasInterrupts(cause)) {
                  failureStage = "upstream";
                  outcome = "upstream_transport_error";
                }
              }),
            ),
          );
          const checkedSource = source.pipe(
            Stream.mapEffect((chunk) =>
              checked(
                "upstream",
                Effect.try({
                  try: () => {
                    const frames = upstream.push(chunk);
                    for (const frame of frames) {
                      const error = modelServiceStreamEvent(protocol, frame).error;
                      if (error)
                        upstreamErrorCode = upstreamErrorDetails(parseUpstreamError(error)).code;
                    }
                    return { chunk, frames };
                  },
                  catch: integrityError,
                }),
              ).pipe(
                Effect.flatMap((result) => {
                  if (!upstream.isZeroTokenStop()) return Effect.succeed(result);
                  zeroTokenStopDetected = true;
                  outcome = "zero_token_stop";
                  failureStage = "upstream";
                  return Effect.fail(
                    new ModelServiceError({ detail: ZERO_TOKEN_STOP_MESSAGE, status: 502 }),
                  );
                }),
              ),
            ),
          );
          const converted = bridge
            ? checkedSource.pipe(
                Stream.flatMap(({ frames }) => Stream.fromIterable(frames)),
                Stream.mapEffect((frame) => {
                  bridgeFrames++;
                  return checked("bridge", bridge.chunk(frame));
                }),
                Stream.flatMap(Stream.fromIterable),
                Stream.mapEffect((chunk) =>
                  checked(
                    "bridge",
                    Effect.try({
                      try: () => {
                        convertedMonitor?.push(chunk);
                        return chunk;
                      },
                      catch: integrityError,
                    }),
                  ),
                ),
              )
            : checkedSource.pipe(Stream.map(({ chunk }) => chunk));
          const finalized = Stream.concat(
            converted,
            Stream.unwrap(
              Effect.gen(function* () {
                upstreamEof = true;
                yield* checked(
                  "upstream",
                  Effect.try({ try: () => upstream.finish(), catch: integrityError }),
                );
                bridgeFinishAttempted = bridge !== undefined;
                const tail = bridge ? yield* checked("bridge", bridge.finish()) : [];
                if (convertedMonitor) {
                  yield* checked(
                    "bridge",
                    Effect.try({
                      try: () => {
                        for (const chunk of tail) convertedMonitor.push(chunk);
                        convertedMonitor.finish();
                      },
                      catch: integrityError,
                    }),
                  );
                  convertedFinalized = true;
                }
                return Stream.fromIterable(tail);
              }),
            ),
          ).pipe(
            Stream.mapEffect((chunk) =>
              checked(
                "downstream",
                Effect.try({
                  try: () => {
                    downstream.push(chunk);
                    downstreamBytes += chunk.length;
                    return chunk;
                  },
                  catch: integrityError,
                }),
              ),
            ),
            Stream.concat(
              Stream.fromEffect(
                checked(
                  "downstream",
                  Effect.try({
                    try: () => {
                      downstream.finish();
                      downstreamEnded = true;
                      const terminal = downstream.snapshot().terminal;
                      outcome = terminal === "completed" ? "completed" : terminal;
                    },
                    catch: integrityError,
                  }),
                ),
              ).pipe(Stream.drain),
            ),
          );
          const streamError = (code: string, message: string) =>
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify(
                incoming === "gemini"
                  ? {
                      error: {
                        code: code === "cox_model_service_request_cancelled" ? 499 : 502,
                        status:
                          code === "cox_model_service_request_cancelled" ? "CANCELLED" : "INTERNAL",
                        message,
                      },
                    }
                  : incoming === "openai-responses"
                    ? { type: "error", code, message, param: null }
                    : {
                        type: "error",
                        error: {
                          type:
                            code === "cox_model_service_request_cancelled"
                              ? "request_cancelled"
                              : "stream_error",
                          code,
                          message,
                        },
                      },
              )}\n\n`,
            );
          const bytes = finalized.pipe(
            Stream.interruptWhen(
              Effect.gen(function* () {
                while (true) {
                  if (yield* tracking.cancelled) {
                    outcome = "request_cancelled";
                    return yield* new ModelServiceRequestCancelled({
                      detail: "The model service request was cancelled.",
                    });
                  }
                  if (!(yield* enabled)) {
                    outcome = "service_disabled";
                    return yield* new ModelServiceError({
                      detail: "This model service is unavailable.",
                      status: 503,
                    });
                  }
                  yield* Effect.sleep(250);
                }
              }),
            ),
            Stream.onError((cause) =>
              Effect.sync(() => {
                if (Cause.hasInterrupts(cause)) outcome = "downstream_interrupted";
                else if (outcome === "not_consumed") outcome = "stream_error";
              }),
            ),
            Stream.catch((error) => {
              if (
                downstream.snapshot().terminal === "error" ||
                downstream.snapshot().terminal === "failed"
              )
                return Stream.empty;
              errorEmitted = true;
              const cancelled = error instanceof ModelServiceRequestCancelled;
              const unavailable = outcome === "service_disabled";
              return Stream.succeed(
                streamError(
                  cancelled
                    ? "cox_model_service_request_cancelled"
                    : upstreamErrorCode
                      ? upstreamErrorCode
                      : zeroTokenStopDetected
                        ? ZERO_TOKEN_STOP_CODE
                        : unavailable
                          ? "cox_model_service_unavailable"
                          : error instanceof ModelServiceStreamError || isModelServiceError(error)
                            ? "cox_model_service_incomplete_stream"
                            : "cox_model_service_stream_interrupted",
                  cancelled
                    ? error.detail
                    : upstreamErrorCode
                      ? `The model service returned a stream error (${upstreamErrorCode}).`
                      : zeroTokenStopDetected
                        ? ZERO_TOKEN_STOP_MESSAGE
                        : unavailable
                          ? "This model service is unavailable."
                          : error instanceof ModelServiceStreamError
                            ? error.detail
                            : "Connection lost: the model service stream was interrupted before protocol completion.",
                ),
              );
            }),
            Stream.onExit((exit) =>
              Effect.sync(() => {
                downstreamExit = Exit.isFailure(exit)
                  ? Cause.hasInterrupts(exit.cause)
                    ? "interrupted"
                    : "failed"
                  : downstreamEnded
                    ? "exhausted"
                    : "stopped";
                if (Exit.isFailure(exit) && failureStage === undefined) {
                  failureStage = "downstream";
                  outcome = `downstream_${downstreamExit}`;
                }
              }),
            ),
          );
          return HttpServerResponse.stream(bytes, {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache" },
          });
        }
        const result = yield* response.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32 * 1024 * 1024)),
          Effect.mapError((error) =>
            error.reason.cause instanceof SyntaxError
              ? new ModelServiceRequestFailure({
                  detail: "The model service returned an invalid JSON response.",
                  status: 502,
                  retryable: false,
                  code: "upstream_invalid_response",
                  source: "upstream",
                })
              : error,
          ),
        );
        const error = parseUpstreamError(result);
        const details = upstreamErrorDetails(error);
        if (
          record(result).error ||
          (details.code && !modelServiceResponseIsValid(protocol, result))
        ) {
          const status = Number(error.status ?? error.code);
          return yield* rejectedFailure(
            details.code === "invalid_encrypted_content"
              ? 400
              : status >= 400 && status < 600
                ? status
                : 502,
            error,
            "upstream_response_error",
            "The model service returned an error in a successful HTTP response.",
            response.headers,
          );
        }
        if (!countTokens && !modelServiceResponseIsValid(protocol, result))
          return yield* new ModelServiceRequestFailure({
            detail: "The model service returned an empty or invalid response.",
            status: 502,
            retryable: true,
            code: "upstream_invalid_response",
            source: "upstream",
          });
        yield* diagnostic({
          event: "response_body_complete",
          attempt: attemptId,
          elapsedMs: (yield* Clock.currentTimeMillis) - started,
        });
        if (protocol === "openai-chat" && !countTokens) {
          const output = chatResponseOutput(result);
          yield* diagnostic({ event: "response_output", attempt: attemptId, output });
          if (output.zeroTokenStop)
            return yield* new ModelServiceRequestFailure({
              detail: ZERO_TOKEN_STOP_MESSAGE,
              code: ZERO_TOKEN_STOP_CODE,
              status: 502,
              retryable: false,
              source: "gateway",
            });
        }
        return HttpServerResponse.jsonUnsafe(bridge ? yield* bridge.response(result) : result);
      },
      Effect.mapError((error) =>
        error instanceof ModelServiceRequestFailure
          ? error
          : error instanceof ModelServiceStreamError
            ? new ModelServiceRequestFailure({
                detail: error.detail,
                status: 502,
                retryable: true,
                code: "upstream_incomplete_stream",
                source: "upstream",
              })
            : new ModelServiceRequestFailure({
                detail: isModelServiceError(error)
                  ? error.detail
                  : "The model service connection failed or timed out.",
                status: isModelServiceError(error) ? (error.status ?? 502) : 502,
                retryable: !isModelServiceError(error),
                code: isModelServiceError(error)
                  ? "gateway_protocol_error"
                  : "upstream_transport_error",
                source: "gateway",
              }),
      ),
      Effect.catchTag("ModelServiceRequestFailure", (error) =>
        error.code === "context_length_exceeded" ||
        (error.code === "upstream_invalid_response" && !error.retryable)
          ? Effect.succeed(recoveryFailureResponse(incoming, error))
          : Effect.fail(error),
      ),
    );
    const stateful =
      countTokens || Boolean(body.background || body.previous_response_id || body.conversation);
    const convertedTools = record(initialBridge?.body ?? body).tools;
    const upstreamTools =
      Array.isArray(convertedTools) &&
      convertedTools.some((tool: unknown) => {
        const type = record(tool).type;
        return (
          (typeof type === "string" && !["function", "custom", "computer"].includes(type)) ||
          Boolean(
            record(tool).googleSearch || record(tool).codeExecution || record(tool).urlContext,
          )
        );
      });
    const policy = {
      ...service.recovery,
      retryEnabled:
        service.recovery.retryEnabled &&
        !stateful &&
        (!upstreamTools || service.recovery.retryToolRequests),
      hedgeEnabled: service.recovery.hedgeEnabled && !stateful && !upstreamTools,
    };
    const reasoning = modelServiceHasReasoning(body, selected.supportsReasoning);
    yield* diagnostic({
      event: "policy",
      configured: service.recovery,
      effective: policy,
      reasoning,
      hedgeDelayMs: reasoning ? policy.reasoningHedgeDelayMs : policy.hedgeDelayMs,
      hedgeDisabledReason: !service.recovery.hedgeEnabled
        ? "configured_off"
        : stateful
          ? "stateful_request"
          : upstreamTools
            ? "upstream_tools"
            : undefined,
      retryDisabledReason: !service.recovery.retryEnabled
        ? "configured_off"
        : stateful
          ? "stateful_request"
          : upstreamTools && !service.recovery.retryToolRequests
            ? "upstream_tools"
            : undefined,
    });
    return yield* recoverModelServiceRequest({
      policy,
      reasoning,
      load,
      enabled,
      cancelled: tracking.cancelled,
      attempt,
      repair: Effect.fn("ModelServiceGateway.repair")(function* (
        error: ModelServiceRequestFailure,
      ) {
        if (error.code === "unsupported_forced_tool_choice") {
          if (protocol !== "openai-chat" || !canRepairForcedToolChoice || relaxForcedToolChoice)
            return false;
          relaxForcedToolChoice = true;
          yield* diagnostic({
            event: "request_repaired",
            reason: error.code,
            repair: "automatic_tool_choice",
          });
          return true;
        }
        if (error.code === "incompatible_tool_choice_thinking") {
          if (
            (protocol !== "openai-chat" && protocol !== "anthropic-messages") ||
            !canRepairForcedToolThinking ||
            disableForcedToolThinking
          )
            return false;
          disableForcedToolThinking = true;
          yield* diagnostic({
            event: "request_repaired",
            reason: error.code,
            repair: "disabled_thinking_for_forced_tool",
          });
          return true;
        }
        if (protocol !== "openai-responses" || !hasEncryptedReasoning || omitEncryptedReasoning)
          return false;
        omitEncryptedReasoning = true;
        yield* diagnostic({
          event: "request_repaired",
          reason: "invalid_encrypted_content",
          repair: "removed_encrypted_reasoning",
        });
        return true;
      }),
      progress: tracking.progress,
      diagnostic: (event) => diagnostic({ ...event }),
    }).pipe(
      Effect.catchTags({
        ModelServiceRequestCancelled: (error) =>
          Effect.succeed(
            gatewayErrorResponse(incoming, 499, {
              type: "request_cancelled",
              message: error.detail,
              code: "cox_model_service_request_cancelled",
            }),
          ),
        ModelServiceRequestFailure: (error) =>
          Effect.succeed(recoveryFailureResponse(incoming, error)),
      }),
    );
  }).pipe(
    Effect.catchTag("ModelServiceError", (error) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return gatewayErrorResponse(
          incomingProtocol(new URL(request.url, "http://127.0.0.1").pathname),
          error.status ?? 502,
          { message: error.detail },
        );
      }),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            return gatewayErrorResponse(
              incomingProtocol(new URL(request.url, "http://127.0.0.1").pathname),
              502,
              {
                message: "The model service request could not be completed.",
              },
            );
          }),
    ),
  );
  return { materialize, handle, lifecycle };
});

export const layer = Layer.effect(ModelServiceGateway)(make);
export const layerRoutes = HttpRouter.add(
  "*",
  "/api/model-gateway/*",
  Effect.flatMap(ModelServiceGateway, (gateway) => gateway.handle),
);
