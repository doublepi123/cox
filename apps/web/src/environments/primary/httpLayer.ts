import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

export function layerForCurrentOrigin() {
  return Layer.merge(
    layerRemoteHttpClient((input, init) => globalThis.fetch(input, init)),
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
  );
}

export const layer = layerForCurrentOrigin();
