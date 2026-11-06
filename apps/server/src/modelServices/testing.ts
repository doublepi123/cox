import {
  ModelServiceError,
  type ModelServiceConfig,
  type ModelServiceProtocol,
  type ModelServiceTestInput,
  type ModelServiceTestResult,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ServerSettingsService } from "../serverSettings.ts";
import { modelServiceEndpoint, modelServiceHeaders } from "./discovery.ts";

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isModelServiceError = Schema.is(ModelServiceError);

function testRequest(service: ModelServiceConfig, protocol: ModelServiceProtocol, modelId: string) {
  const prompt = "Reply with OK.";
  switch (protocol) {
    case "openai-responses":
      return {
        url: modelServiceEndpoint(service, protocol, "responses"),
        body: { model: modelId, input: prompt, max_output_tokens: 32, stream: false, store: false },
      };
    case "openai-chat":
      return {
        url: modelServiceEndpoint(service, protocol, "chat/completions"),
        body: {
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          ...(/^(?:gpt-[5-9]|o[0-9])(?:[.-]|$)/i.test(modelId.split("/").at(-1) ?? "")
            ? { max_completion_tokens: 32 }
            : { max_tokens: 32 }),
          stream: false,
        },
      };
    case "anthropic-messages":
      return {
        url: modelServiceEndpoint(service, protocol, "messages"),
        body: {
          model: modelId,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 32,
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
          generationConfig: { maxOutputTokens: 32 },
        },
      };
  }
}

function validResponse(protocol: ModelServiceProtocol, value: unknown): boolean {
  const body = record(value);
  if (body.error) return false;
  switch (protocol) {
    case "openai-chat":
      return Array.isArray(body.choices) && body.choices.length > 0;
    case "openai-responses":
      return Array.isArray(body.output) && body.status !== "failed" && body.status !== "cancelled";
    case "anthropic-messages":
      return body.type === "message" && Array.isArray(body.content);
    case "gemini":
      return Array.isArray(body.candidates) && body.candidates.length > 0;
  }
}

export const testModelService = Effect.fn("testModelService")(
  function* (input: ModelServiceTestInput) {
    const settings = yield* ServerSettingsService;
    const service = (yield* settings.getSettings).modelServices[input.serviceId];
    if (!service?.enabled)
      return yield* new ModelServiceError({ detail: "This model service is missing or disabled." });
    if (service.revision !== input.revision)
      return yield* new ModelServiceError({
        detail: "The model service changed. Test its current settings again.",
      });
    const model = service.models.find((candidate) => candidate.id === input.modelId);
    if (!model || model.ignored || model.available === false)
      return yield* new ModelServiceError({
        detail: "This model is missing, unavailable or ignored.",
      });
    const http = yield* HttpClient.HttpClient;
    const started = yield* Clock.currentTimeMillis;
    let result: Pick<ModelServiceTestResult, "ok" | "protocol" | "message"> = {
      ok: false,
      protocol: null,
      message: "No compatible protocol is configured for this model.",
    };
    for (const protocol of service.protocols.filter(
      (candidate) => !model.protocols || model.protocols.includes(candidate),
    )) {
      const request = testRequest(service, protocol, model.id);
      const outcome = yield* Effect.scoped(
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
          const body = yield* response.text.pipe(
            Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(1024 * 1024)),
          );
          if (response.status < 200 || response.status >= 300)
            return { ok: false, message: `Model test failed (HTTP ${response.status}).` };
          const valid = validResponse(protocol, yield* decodeResponse(body));
          return {
            ok: valid,
            message: valid ? null : "The model returned an invalid test response.",
          };
        }),
      ).pipe(
        Effect.timeout("20 seconds"),
        Effect.orElseSucceed(() => ({
          ok: false,
          message: "The model test timed out or could not reach the service.",
        })),
      );
      result = { ...outcome, protocol };
      if (outcome.ok) break;
    }
    if (!Equal.equals((yield* settings.getSettings).modelServices[input.serviceId], service))
      return yield* new ModelServiceError({
        detail: "The model service changed. Test its current settings again.",
      });
    return {
      ...result,
      modelId: model.id,
      revision: service.revision,
      durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - started),
    } satisfies ModelServiceTestResult;
  },
  Effect.mapError((error) =>
    isModelServiceError(error)
      ? error
      : new ModelServiceError({ detail: "Could not read the saved model service settings." }),
  ),
);
