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
import { makeModelServiceSseParser } from "./sse.ts";
import { modelServiceRequestBody } from "./requestCompatibility.ts";
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
const PREFIX = "/api/model-gateway";
const isModelServiceError = Schema.is(ModelServiceError);
const recoveryFailureResponse = (error: ModelServiceRequestFailure) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        message: error.detail,
        code: error.code ?? "cox_model_service_recovery_exhausted",
        source: error.source,
        terminationReason: error.terminationReason,
        budgetMs: error.budgetMs,
        elapsedMs: error.elapsedMs,
        attempts: error.attempts,
        lastAttemptFailure: error.lastAttemptFailure,
      },
    },
    { status: error.status, headers: { "x-should-retry": "false" } },
  );

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
        if (models.length === 0) {
          bindings.delete(id);
          next[id] = {
            ...instance,
            enabled: false,
            config: { ...record(instance.config), enabled: false },
          };
          continue;
        }
        const selected = binding.defaultModel ?? models[0]!.id;
        const prior = bindings.get(id);
        const token =
          prior?.binding.serviceId === binding.serviceId
            ? prior.token
            : yield* crypto.randomUUIDv4();
        bindings.set(id, { token, binding, driver: instance.driver });
        const native = record(instance.config);
        const protocol = modelServiceAgentProtocol(instance.driver, service);
        const directory = path.join(config.baseDir, "model-services", "runtime", id);
        const runtimeModels = activeModels.map((model) => ({
          slug: modelServiceModelSlug(instance.driver, model.id),
          name: model.name ?? model.id,
          ...(model.capabilities
            ? { capabilities: modelServiceAgentCapabilities(instance.driver, model.capabilities) }
            : {}),
        }));
        const environment = [...(instance.environment ?? [])].filter(
          (variable) => variable.name !== "COX_MODEL_SERVICE_KEY",
        );
        environment.push({ name: "COX_MODEL_SERVICE_KEY", value: token, sensitive: true });
        if (instance.driver === "claudeAgent") {
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
        if (instance.driver === "pi") {
          const agentDir = path.join(directory, "pi");
          yield* write(path.join(agentDir, "models.json"), {
            providers: {
              cox: {
                baseUrl: baseUrl + (protocol === "gemini" ? "/v1beta" : "/v1"),
                api: API_NAMES[protocol],
                apiKey: "$COX_MODEL_SERVICE_KEY",
                models: activeModels.map((model) => {
                  const thinking = modelServiceAgentCapabilities("pi", model.capabilities)
                    ?.optionDescriptors?.[0];
                  const levels = thinking?.type === "select" ? thinking.options : [];
                  return {
                    id: model.id,
                    name: model.name ?? model.id,
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
                  };
                }),
              },
            },
          });
          Object.assign(additions, { agentDir, provider: "cox", model: selected, apiKey: "" });
        }
        if (instance.driver === "opencode") {
          const opencode = {
            provider: {
              cox: {
                name: service.name,
                npm: SDK_PACKAGES[protocol],
                options: {
                  baseURL: baseUrl + (protocol === "gemini" ? "/v1beta" : "/v1"),
                  apiKey: token,
                },
                models: Object.fromEntries(
                  activeModels.map((model) => [
                    model.id,
                    {
                      name: model.name ?? model.id,
                      ...(model.capabilities?.contextWindow && model.maxOutputTokens
                        ? {
                            limit: {
                              context: model.capabilities.contextWindow,
                              output: model.maxOutputTokens,
                            },
                          }
                        : {}),
                    },
                  ]),
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
    const token =
      request.headers.authorization?.replace(/^Bearer /i, "") ??
      request.headers["x-api-key"] ??
      request.headers["x-goog-api-key"];
    const runtime = token
      ? [...bindings.values()].find((entry) => entry.token === token.split(".")[0])
      : undefined;
    if (!runtime || request.headers.origin)
      return HttpServerResponse.jsonUnsafe(
        { error: { message: "Model gateway authentication required." } },
        { status: 401 },
      );
    const service = (yield* settings.getSettings).modelServices[runtime.binding.serviceId];
    const sessionId = token?.slice(runtime.token.length + 1);
    if (!service?.enabled)
      return HttpServerResponse.jsonUnsafe(
        { error: { message: "This model service is unavailable." } },
        { status: 503 },
      );
    const models = boundModelServiceModels(service, runtime.binding);
    const url = new URL(request.url, "http://127.0.0.1");
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
    const countTokens = url.pathname === PREFIX + "/v1/messages/count_tokens";
    const incoming: ModelServiceProtocol | undefined =
      url.pathname === PREFIX + "/v1/responses"
        ? "openai-responses"
        : url.pathname === PREFIX + "/v1/chat/completions"
          ? "openai-chat"
          : url.pathname === PREFIX + "/v1/messages" || countTokens
            ? "anthropic-messages"
            : /^\/api\/model-gateway\/v1beta\/models\/.+:(?:streamGenerateContent|generateContent)$/.test(
                  url.pathname,
                )
              ? "gemini"
              : undefined;
    if (!incoming || request.method !== "POST") return HttpServerResponse.empty({ status: 404 });
    const body = record(
      yield* request.json.pipe(
        Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(16 * 1024 * 1024)),
        Effect.mapError(
          () =>
            new ModelServiceError({ detail: "Invalid model service request body.", status: 400 }),
        ),
      ),
    );
    const requestDigest = yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(url.pathname + (yield* encode(body))),
    );
    const tracking = lifecycle.request(
      sessionId ? ProviderSessionId.make(sessionId) : undefined,
      Buffer.from(requestDigest).toString("hex"),
    );
    if (tracking.failure) {
      yield* Effect.logInfo("Model gateway recovery", {
        event: "cached_failure",
        requestId: yield* crypto.randomUUIDv4(),
        sessionId,
        ...tracking.context,
        incoming,
        terminationReason: tracking.failure.terminationReason,
        attempts: tracking.failure.attempts,
        budgetMs: tracking.failure.budgetMs,
      });
      return recoveryFailureResponse(tracking.failure);
    }
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
      return HttpServerResponse.jsonUnsafe(
        { error: { message: "This model is not allowed by the agent binding." } },
        { status: 403 },
      );
    if (selected.available === false)
      return HttpServerResponse.jsonUnsafe(
        {
          error: {
            message:
              "This model is no longer advertised by the model service. Refresh its catalog or select another model.",
          },
        },
        { status: 503 },
      );
    const available = selected.protocols ?? service.protocols;
    const protocol =
      available.includes(incoming) && service.protocols.includes(incoming)
        ? incoming
        : available.find((value) => service.protocols.includes(value));
    if (!protocol)
      return HttpServerResponse.jsonUnsafe(
        { error: { message: "No compatible upstream protocol is configured for this model." } },
        { status: 422 },
      );
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
    const requestId = yield* crypto.randomUUIDv4();
    const diagnostic = (event: Readonly<Record<string, unknown>>) =>
      Effect.logInfo("Model gateway recovery", {
        requestId,
        sessionId,
        ...tracking.context,
        incoming,
        protocol,
        ...event,
      });
    const attempt = Effect.fn("ModelServiceGateway.attempt")(
      function* (attemptId: number) {
        const started = yield* Clock.currentTimeMillis;
        yield* Effect.annotateCurrentSpan({ requestId, attempt: attemptId, incoming, protocol });
        const bridge =
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
          headers["anthropic-beta"] = request.headers["anthropic-beta"];
        const outgoing = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(upstreamUrl.href).pipe(HttpClientRequest.setHeaders(headers)),
          modelServiceRequestBody(protocol, selected.id, bridge ? record(bridge.body) : body),
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
          const rejected = record(
            yield* response.stream.pipe(
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
            ),
          );
          const error = record(rejected.error);
          const unsupportedUltra =
            protocol === "openai-chat" &&
            typeof error.message === "string" &&
            /^Invalid value: 'ultra'\. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'\.(?: \(request id: [A-Za-z0-9_-]+\))?$/.test(
              error.message,
            );
          const parameter = unsupportedUltra
            ? "reasoning_effort"
            : typeof error.param === "string"
              ? /^(model|max_tokens|max_completion_tokens|reasoning_effort|service_tier|thinking|output_config|tools|messages)(?:\.|\[|$)/.exec(
                  error.param,
                )?.[1]
              : undefined;
          const code =
            typeof error.code === "string" &&
            [
              "unsupported_parameter",
              "unsupported_value",
              "invalid_request_error",
              "invalid_parameter",
              "context_length_exceeded",
            ].includes(error.code)
              ? error.code
              : undefined;
          const details = [
            parameter ? `parameter: ${parameter}` : undefined,
            code ? `code: ${code}` : undefined,
            unsupportedUltra ? "unsupported effort; allowed maximum: max" : undefined,
          ].filter(Boolean);
          return yield* new ModelServiceRequestFailure({
            detail: `The upstream model service returned HTTP ${response.status}.${details.length ? ` Rejected request (${details.join(", ")}).` : ""}`,
            status: response.status >= 400 && response.status < 600 ? response.status : 502,
            retryable: isRetryableModelServiceError(response.status, error),
            code: "upstream_http_error",
            source: "upstream",
            retryAfterMs: retryAfterMilliseconds(
              response.headers["retry-after"],
              yield* Clock.currentTimeMillis,
            ),
          });
        }
        if (stream) {
          const rawPull = yield* Stream.toPull(response.stream);
          const pending: Uint8Array[] = [];
          const preview = makeModelServiceSseParser();
          const decoder = new TextDecoder();
          let buffered = 0;
          let progress = false;
          while (!progress) {
            const chunks = yield* rawPull.pipe(
              Pull.catchDone(() =>
                Effect.fail(
                  new ModelServiceRequestFailure({
                    detail: "The model service stream ended before producing a usable response.",
                    status: 502,
                    retryable: true,
                    code: "upstream_stream_ended_before_output",
                    source: "upstream",
                  }),
                ),
              ),
            );
            for (const chunk of chunks) {
              pending.push(chunk);
              buffered += chunk.length;
              if (buffered > 1024 * 1024)
                return yield* new ModelServiceRequestFailure({
                  detail:
                    "The model service sent too much data before producing a usable response.",
                  status: 502,
                  retryable: false,
                  code: "gateway_preview_limit",
                  source: "gateway",
                });
              for (const frame of preview(decoder.decode(chunk, { stream: true }))) {
                const event = modelServiceStreamEvent(protocol, frame);
                if (event.error) {
                  const status = Number(event.error.status ?? event.error.code);
                  const retryable = isRetryableModelServiceError(
                    status >= 400 && status < 600 ? status : 502,
                    event.error,
                  );
                  return yield* new ModelServiceRequestFailure({
                    detail:
                      "The model service returned a stream error before producing a usable response.",
                    status: status >= 400 && status < 600 ? status : retryable ? 502 : 422,
                    retryable,
                    code: "upstream_stream_error",
                    source: "upstream",
                  });
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
          const source = Stream.concat(
            Stream.fromIterable(pending),
            Stream.fromPull(Effect.succeed(rawPull)),
          );
          const parse = makeModelServiceSseParser();
          const bytes = (
            bridge
              ? source.pipe(
                  Stream.decodeText(),
                  Stream.map((chunk) => parse(chunk)),
                  Stream.flatMap(Stream.fromIterable),
                  Stream.mapEffect((line) => bridge.chunk(line)),
                  Stream.flatMap(Stream.fromIterable),
                )
              : source
          ).pipe(
            Stream.interruptWhen(
              Effect.gen(function* () {
                while (true) {
                  if (yield* tracking.cancelled)
                    return yield* new ModelServiceRequestCancelled({
                      detail: "The model service request was cancelled.",
                    });
                  if (!(yield* enabled))
                    return yield* new ModelServiceError({
                      detail: "This model service is unavailable.",
                      status: 503,
                    });
                  yield* Effect.sleep(250);
                }
              }),
            ),
            Stream.catchTag("ModelServiceRequestCancelled", (error) =>
              Stream.succeed(
                new TextEncoder().encode(
                  `event: error\ndata: ${JSON.stringify(
                    incoming === "gemini"
                      ? { error: { code: 499, status: "CANCELLED", message: error.detail } }
                      : incoming === "openai-responses"
                        ? {
                            type: "error",
                            code: "cox_model_service_request_cancelled",
                            message: error.detail,
                            param: null,
                          }
                        : {
                            type: "error",
                            error: {
                              type: "request_cancelled",
                              code: "cox_model_service_request_cancelled",
                              message: error.detail,
                            },
                          },
                  )}\n\n`,
                ),
              ),
            ),
            Stream.mapError(
              (_error: unknown) =>
                new ModelServiceError({ detail: "The model service stream was interrupted." }),
            ),
          );
          return HttpServerResponse.stream(bytes, {
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache" },
          });
        }
        const result = yield* response.json.pipe(
          Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(32 * 1024 * 1024)),
        );
        if (record(result).error) {
          const error = record(record(result).error);
          const status = Number(error.status ?? error.code);
          return yield* new ModelServiceRequestFailure({
            detail: "The model service returned an error in a successful HTTP response.",
            status: status >= 400 && status < 600 ? status : 502,
            retryable: isRetryableModelServiceError(
              status >= 400 && status < 600 ? status : 502,
              error,
            ),
            code: "upstream_response_error",
            source: "upstream",
          });
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
        return HttpServerResponse.jsonUnsafe(bridge ? yield* bridge.response(result) : result);
      },
      Effect.mapError((error) =>
        error instanceof ModelServiceRequestFailure
          ? error
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
    );
    const stateful =
      countTokens || Boolean(body.background || body.previous_response_id || body.conversation);
    const upstreamTools =
      Array.isArray(body.tools) &&
      body.tools.some((tool) => {
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
      progress: tracking.progress,
      diagnostic: (event) => diagnostic({ ...event }),
    }).pipe(
      Effect.catchTags({
        ModelServiceRequestCancelled: (error) =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              {
                type: "error",
                error: {
                  type: "request_cancelled",
                  message: error.detail,
                  code: "cox_model_service_request_cancelled",
                },
              },
              { status: 499, headers: { "x-should-retry": "false" } },
            ),
          ),
        ModelServiceRequestFailure: (error) =>
          tracking.failed(error).pipe(Effect.as(recoveryFailureResponse(error))),
      }),
    );
  }).pipe(
    Effect.catchTag("ModelServiceError", (error) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: { message: error.detail } },
          { status: error.status ?? 502 },
        ),
      ),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.interrupt
        : Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: { message: "The model service request could not be completed." } },
              { status: 502 },
            ),
          ),
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
