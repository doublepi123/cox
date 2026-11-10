import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { descriptor, target } from "../connection/localTestFixtures.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { fetchRemoteEnvironmentDescriptor } from "./descriptor.ts";

describe("connection descriptor requests", () => {
  it.effect("bypasses cached metadata without changing cookie or redirect policy", () => {
    const requests: Request[] = [];
    return Effect.gen(function* () {
      const result = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl: target.httpBaseUrl });
      expect(result.environmentId).toBe(target.environmentId);
      expect(requests).toHaveLength(1);
      expect(requests[0]!.cache).toBe("no-store");
      expect(requests[0]!.credentials).toBe("include");
      expect(requests[0]!.redirect).toBe("error");
      expect(requests[0]!.headers.get("authorization")).toBeNull();
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        credentials: "include",
        redirect: "error",
      }),
      Effect.provide(
        layerRemoteHttpClient(async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(descriptor);
        }),
      ),
    );
  });

  it.effect("aborts a stalled fetch at its deadline before a fresh attempt", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let aborted = false;
      let requests = 0;
      const dependencies = layerRemoteHttpClient((input, init) => {
        requests++;
        if (requests > 1) return Promise.resolve(Response.json(descriptor));
        return new Promise<Response>((_resolve, reject) => {
          const request = new Request(input, init);
          request.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          Deferred.doneUnsafe(started, Effect.void);
        });
      });
      const first = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: target.httpBaseUrl,
        timeoutMs: 1000,
      }).pipe(Effect.result, Effect.provide(dependencies), Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      const failure = yield* Fiber.join(first);
      expect(failure._tag).toBe("Failure");
      if (failure._tag === "Failure")
        expect(failure.failure).toMatchObject({
          _tag: "RemoteEnvironmentAuthTimeoutError",
          timeoutMs: 1000,
        });
      expect(aborted).toBe(true);
      const fresh = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: target.httpBaseUrl,
      }).pipe(Effect.provide(dependencies));
      expect(fresh.environmentId).toBe(target.environmentId);
      expect(requests).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
