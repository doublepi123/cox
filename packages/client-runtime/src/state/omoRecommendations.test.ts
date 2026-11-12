import { describe, expect, it } from "@effect/vitest";
import {
  AuthProvidersManageScope,
  EnvironmentId,
  ModelServiceId,
  WS_METHODS,
  type AuthSessionState,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { PrimaryConnectionTarget } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

describe("OMO recommendation command", () => {
  it.effect.each([true, false])(
    "dispatches only with provider-management permission: %s",
    (allowed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const environmentId = EnvironmentId.make("models-environment");
          const serviceId = ModelServiceId.make("models");
          const input = {
            serviceId,
            revision: 2,
            modelId: "generator",
            binding: { serviceId, modelIds: ["generator"] },
            agents: ["sisyphus"],
            categories: ["quick"],
            prompt: "Prioritize coding reliability for complex roles.",
          };
          const result = {
            agentModels: { sisyphus: "cox/generator" },
            categoryModels: { quick: "cox/generator" },
            explanation: "Use the available bound model.",
          };
          const calls: unknown[] = [];
          const supervisor = EnvironmentSupervisor.of({
            target: new PrimaryConnectionTarget({
              environmentId,
              label: "Models",
              httpBaseUrl: "https://models.test",
              wsBaseUrl: "wss://models.test",
            }),
            session: yield* SubscriptionRef.make(
              Option.some({
                client: {
                  [WS_METHODS.modelServiceRecommendOmoModels]: (payload: unknown) =>
                    Effect.sync(() => {
                      calls.push(payload);
                      return result;
                    }),
                },
              } as unknown as RpcSession),
            ),
          } as EnvironmentSupervisor["Service"]);
          const environments = EnvironmentRegistry.of({
            run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          } as EnvironmentRegistry["Service"]);
          const runtime = Atom.runtime(
            Layer.merge(
              Layer.succeed(EnvironmentRegistry, environments),
              Layer.succeed(EnvironmentCacheStore, {} as EnvironmentCacheStore["Service"]),
            ),
          );
          const atoms = createServerEnvironmentAtoms(runtime, {
            initialConfigValueAtom: () => Atom.make<ServerConfig | null>(null),
          });
          const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
            Effect.sync(() => value.dispose()),
          );
          registry.mount(sessions(environmentId));
          registry.set(
            sessions(environmentId),
            AsyncResult.success({
              authenticated: true,
              auth: {
                policy: "remote-reachable",
                loginMode: "local",
                sessionMethods: [],
                sessionCookieName: "test",
              },
              scopes: allowed ? [AuthProvidersManageScope] : [],
              permissions: allowed ? [AuthProvidersManageScope] : [],
            }),
          );
          expect(atoms.recommendOmoModels.requiredScopes(input)).toEqual([
            AuthProvidersManageScope,
          ]);
          const outcome = yield* Effect.promise(() =>
            atoms.recommendOmoModels.run(registry, { environmentId, input }),
          );
          if (allowed) {
            expect(outcome).toMatchObject({ _tag: "Success", value: result });
            expect(calls).toEqual([input]);
          } else {
            expect(outcome._tag).toBe("Failure");
            expect(calls).toEqual([]);
          }
        }),
      ),
  );
});
