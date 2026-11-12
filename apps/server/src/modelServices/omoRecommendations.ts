import {
  ModelServiceError,
  ModelServiceRecommendOmoModelsInput,
  ModelServiceRecommendOmoModelsResult,
  type ModelServiceConfig,
  type ModelServiceProtocol,
} from "@t3tools/contracts";
import { boundModelServiceModels } from "@t3tools/shared/modelServices";
import {
  DEFAULT_OMO_RECOMMENDATION_PROMPT,
  omoModelReasoningLevels,
} from "@t3tools/shared/omoRecommendations";
import { officialOmoAssignment, omoRoleInfo, type OmoRoleKind } from "@t3tools/shared/omoRoles";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { modelServiceEndpoint, modelServiceHeaders } from "./discovery.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeEffect(ModelServiceRecommendOmoModelsInput);
const decodeResult = Schema.decodeUnknownEffect(ModelServiceRecommendOmoModelsResult);
const isModelServiceError = Schema.is(ModelServiceError);

function recommendationRequest(
  service: ModelServiceConfig,
  protocol: ModelServiceProtocol,
  modelId: string,
  prompt: string,
  maxOutputTokens: number,
) {
  switch (protocol) {
    case "openai-responses":
      return {
        url: modelServiceEndpoint(service, protocol, "responses"),
        body: {
          model: modelId,
          input: prompt,
          max_output_tokens: maxOutputTokens,
          stream: false,
          store: false,
          text: { format: { type: "json_object" } },
        },
      };
    case "openai-chat":
      return {
        url: modelServiceEndpoint(service, protocol, "chat/completions"),
        body: {
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          ...(/^(?:gpt-[5-9]|o[0-9])(?:[.-]|$)/i.test(modelId.split("/").at(-1) ?? "")
            ? { max_completion_tokens: maxOutputTokens }
            : { max_tokens: maxOutputTokens }),
          stream: false,
          response_format: { type: "json_object" },
        },
      };
    case "anthropic-messages":
      return {
        url: modelServiceEndpoint(service, protocol, "messages"),
        body: {
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxOutputTokens,
          stream: false,
        },
      };
    case "gemini":
      return {
        url: modelServiceEndpoint(
          service,
          protocol,
          `models/${encodeURIComponent(modelId.replace(/^models\//, ""))}:generateContent`,
        ),
        body: {
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens, responseMimeType: "application/json" },
        },
      };
  }
}

function responseText(protocol: ModelServiceProtocol, value: unknown): string {
  const body = record(value);
  if (body.error) return "";
  const texts = (parts: unknown, type: string) =>
    Array.isArray(parts)
      ? parts
          .flatMap((part: unknown) => {
            const entry = record(part);
            return entry.type === type && typeof entry.text === "string" ? [entry.text] : [];
          })
          .join("")
      : "";
  switch (protocol) {
    case "openai-chat": {
      const choice = record(Array.isArray(body.choices) ? body.choices[0] : undefined);
      const message = record(choice.message);
      return choice.finish_reason === "stop" &&
        !message.refusal &&
        !message.tool_calls &&
        !message.function_call &&
        typeof message.content === "string"
        ? message.content
        : "";
    }
    case "openai-responses":
      return body.status === "completed" && Array.isArray(body.output)
        ? body.output
            .map((item: unknown) => {
              const entry = record(item);
              return entry.type === "message" ? texts(entry.content, "output_text") : "";
            })
            .join("")
        : "";
    case "anthropic-messages":
      return body.type === "message" && body.stop_reason === "end_turn"
        ? texts(body.content, "text")
        : "";
    case "gemini": {
      const candidate = record(Array.isArray(body.candidates) ? body.candidates[0] : undefined);
      const parts = record(candidate.content).parts;
      return candidate.finishReason === "STOP" && Array.isArray(parts)
        ? parts
            .flatMap((part: unknown) => {
              const entry = record(part);
              return entry.thought !== true && typeof entry.text === "string" ? [entry.text] : [];
            })
            .join("")
        : "";
    }
  }
}

export const recommendOmoModels = Effect.fn("recommendOmoModels")(
  function* (rawInput: ModelServiceRecommendOmoModelsInput) {
    const input = yield* decodeInput(rawInput);
    if (input.binding.serviceId !== input.serviceId)
      return yield* new ModelServiceError({
        detail: "The binding must use the selected model service.",
      });
    if (
      input.agents.length + input.categories.length === 0 ||
      new Set(input.agents).size !== input.agents.length ||
      new Set(input.categories).size !== input.categories.length
    )
      return yield* new ModelServiceError({ detail: "Request nonempty, unique OMO role names." });
    const settings = yield* ServerSettingsService;
    const service = (yield* settings.getSettings).modelServices[input.serviceId];
    if (!service?.enabled)
      return yield* new ModelServiceError({ detail: "This model service is missing or disabled." });
    if (service.revision !== input.revision)
      return yield* new ModelServiceError({
        detail: "The model service changed. Use its current revision.",
      });
    const models = boundModelServiceModels(service, input.binding).filter(
      (model) => model.available !== false && !model.ignored,
    );
    const generator = models.find((model) => model.id === input.modelId);
    if (!generator)
      return yield* new ModelServiceError({
        detail: "The generator must be an available model in this binding.",
      });
    const protocol = service.protocols.find(
      (candidate) => !generator.protocols || generator.protocols.includes(candidate),
    );
    if (!protocol)
      return yield* new ModelServiceError({
        detail: "No compatible protocol is configured for this model.",
      });
    const allowed = new Set(models.map((model) => `cox/${model.id}`));
    const allowedReasoning = new Map(
      models.map((model) => [`cox/${model.id}`, new Set<string>(omoModelReasoningLevels(model))]),
    );
    const catalog = models.map((model) => ({
      ...model,
      slug: `cox/${model.id}`,
      reasoningLevels: omoModelReasoningLevels(model),
    }));
    const roles = (kind: OmoRoleKind, names: ReadonlyArray<string>) =>
      Object.fromEntries(
        names.map((name) => {
          const info = omoRoleInfo(kind, name);
          return [
            name,
            info
              ? {
                  title: info.title,
                  summary: info.summary,
                  modelGuidance: info.modelGuidance,
                  officialRecommendation: officialOmoAssignment(info, catalog) ?? null,
                }
              : {
                  title: name,
                  summary: "Custom role",
                  modelGuidance: "",
                  officialRecommendation: null,
                },
          ];
        }),
      );
    const prompt = [
      input.prompt?.trim() ? input.prompt : DEFAULT_OMO_RECOMMENDATION_PROMPT,
      "Return ONLY one strict JSON object with exactly agentModels, categoryModels, agentReasoning, categoryReasoning, explanation.",
      "agentModels and categoryModels must contain exactly their requested role keys, all assigned.",
      "Every assignment must be an allowed catalog slug cox/<raw id>, preserving the raw id exactly.",
      "agentReasoning and categoryReasoning must contain exactly their requested role keys. Each value must be a reasoningLevels value supported by the model assigned to that role, or an empty string for the model default. Missing capability metadata does not authorize inventing a thinking strength.",
      "explanation must be a nonempty, concise string justifying the role-to-model matches, quality/efficiency tradeoffs and any uncertainty. Group roles sharing the same rationale when useful, and distinguish catalog facts from prior-knowledge judgments. No markdown.",
      yield* encodeJson({
        catalog,
        roles: {
          agents: roles("agent", input.agents),
          categories: roles("category", input.categories),
        },
        requestedAgents: input.agents,
        requestedCategories: input.categories,
      }),
    ].join("\n");
    const request = recommendationRequest(
      service,
      protocol,
      generator.id,
      prompt,
      Math.min(8192, generator.maxOutputTokens ?? 8192),
    );
    const http = yield* HttpClient.HttpClient;
    const value = yield* Effect.scoped(
      Effect.gen(function* () {
        const outgoing = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(request.url.href).pipe(
            HttpClientRequest.setHeaders(modelServiceHeaders(service, protocol)),
          ),
          request.body,
        );
        const response = yield* HttpClient.withScope(http)
          .execute(outgoing)
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        if (response.status < 200 || response.status >= 300)
          return yield* new ModelServiceError({
            detail: `OMO recommendation failed (HTTP ${response.status}).`,
          });
        const decoder = new TextDecoder();
        let size = 0;
        let text = "";
        yield* Stream.runForEach(response.stream, (chunk) => {
          size += chunk.byteLength;
          if (size > 1024 * 1024)
            return Effect.fail(
              new ModelServiceError({ detail: "The recommendation response exceeded 1 MiB." }),
            );
          text += decoder.decode(chunk, { stream: true });
          return Effect.void;
        });
        return yield* decodeJson(text + decoder.decode());
      }),
    );
    const parsed = yield* decodeJson(responseText(protocol, value));
    const result = yield* decodeResult(parsed);
    const responseObject = record(parsed);
    const agentModels = record(responseObject.agentModels);
    const categoryModels = record(responseObject.categoryModels);
    const agentReasoning = record(responseObject.agentReasoning);
    const categoryReasoning = record(responseObject.categoryReasoning);
    const exactKeys = (actual: object, expected: readonly string[]) =>
      Object.keys(actual).length === expected.length &&
      expected.every((key) => Object.hasOwn(actual, key));
    const validReasoning = (
      assignments: Record<string, unknown>,
      reasoning: Record<string, unknown>,
    ) =>
      Object.entries(reasoning).every(
        ([role, level]) =>
          level === "" ||
          (typeof level === "string" &&
            typeof assignments[role] === "string" &&
            allowedReasoning.get(assignments[role])?.has(level)),
      );
    if (
      !exactKeys(responseObject, [
        "agentModels",
        "categoryModels",
        "agentReasoning",
        "categoryReasoning",
        "explanation",
      ]) ||
      !exactKeys(agentModels, input.agents) ||
      !exactKeys(categoryModels, input.categories) ||
      !exactKeys(agentReasoning, input.agents) ||
      !exactKeys(categoryReasoning, input.categories) ||
      !validReasoning(agentModels, agentReasoning) ||
      !validReasoning(categoryModels, categoryReasoning) ||
      ![...Object.values(agentModels), ...Object.values(categoryModels)].every(
        (slug) => typeof slug === "string" && allowed.has(slug),
      )
    )
      return yield* new ModelServiceError({
        detail: "The recommendation contains invalid, incomplete or unbound assignments.",
      });
    if (!Equal.equals((yield* settings.getSettings).modelServices[input.serviceId], service))
      return yield* new ModelServiceError({
        detail: "The model service changed during recommendation. Retry with its current settings.",
      });
    return result;
  },
  Effect.timeout("120 seconds"),
  Effect.mapError((error) =>
    isModelServiceError(error)
      ? error
      : new ModelServiceError({
          detail: "Could not obtain a valid OMO recommendation. Check the service and try again.",
        }),
  ),
);
