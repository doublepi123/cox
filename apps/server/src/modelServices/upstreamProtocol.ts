import type {
  ModelServiceConfig,
  ModelServiceModel,
  ModelServiceProtocol,
} from "@t3tools/contracts";

export function modelServiceUpstreamProtocol(
  service: ModelServiceConfig,
  model: ModelServiceModel,
  incoming: ModelServiceProtocol,
): ModelServiceProtocol | undefined {
  const available = (model.protocols ?? service.protocols).filter((protocol) =>
    service.protocols.includes(protocol),
  );
  if (new Set(service.protocols).size > 1) {
    const slug = model.id.split("/").at(-1) ?? "";
    const target = /^gpt(?:-|$)/i.test(slug)
      ? "openai-responses"
      : /^kimi(?:-|$)/i.test(slug)
        ? "openai-chat"
        : "anthropic-messages";
    return available.includes(target) ? target : undefined;
  }
  return available.includes(incoming) ? incoming : available[0];
}
