import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveBaseDir } from "../os-jank.ts";
import { DEFAULT_PORT } from "../config.ts";
import {
  resolveServerConfig,
  resolveCliAuthConfig,
  validateListenHost,
  validateLocalHost,
  type CliServerFlags,
} from "./config.ts";

const flags = (baseDir: string): CliServerFlags => ({
  port: Option.some(0),
  host: Option.none(),
  baseDir: Option.some(baseDir),
  cwd: Option.none(),
  devUrl: Option.none(),
  noBrowser: Option.some(true),
  autoBootstrapProjectFromCwd: Option.some(false),
  logWebSocketEvents: Option.none(),
});

const resolveWithEnv = (env: Record<string, string>, overrides: Partial<CliServerFlags> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-config-" });
    return yield* resolveServerConfig({ ...flags(baseDir), ...overrides }, Option.none()).pipe(
      Effect.provide(
        Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
      ),
    );
  });

it.layer(NodeServices.layer)("local CLI configuration", (it) => {
  it.effect("uses the Cox port without sharing the upstream default", () =>
    Effect.sync(() => {
      expect(DEFAULT_PORT).toBe(4773);
    }),
  );
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    it.effect("accepts loopback " + host, () =>
      validateLocalHost(host).pipe(
        Effect.map((actual) => {
          expect(actual).toBe(host);
        }),
      ),
    );
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.2", "example.com", "127.0.0.1.example.com"]) {
    it.effect("rejects external host " + host, () =>
      Effect.flip(validateLocalHost(host)).pipe(
        Effect.map((error) => {
          expect(error.message).toContain("loopback");
        }),
      ),
    );
  }
  it.effect("defaults to loopback and isolated Cox state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-config-" });
      const config = yield* resolveServerConfig(flags(baseDir), Option.none()).pipe(
        Effect.provide(
          Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })), NetService.layer),
        ),
      );
      expect(config.host).toBe("127.0.0.1");
      expect(config.baseDir).toBe(baseDir);
      expect(config.stateDir).toBe(path.join(baseDir, "userdata"));
      expect(config.mode).toBe("web");
      expect(config.authPolicyReadOnly).toBeUndefined();
    }),
  );
  it.effect("refuses live T3 state, including symlink aliases", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "cox-state-boundary-" });
      yield* fs.makeDirectory(path.join(home, ".t3"));
      yield* fs.symlink(path.join(home, ".t3"), path.join(home, "alias"));
      for (const candidate of [
        path.join(home, ".t3"),
        path.join(home, ".t3", "new-state"),
        path.join(home, "alias", "new-state"),
      ]) {
        const error = yield* Effect.flip(resolveBaseDir(candidate)).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
        expect(error.message).toContain("refuses");
      }
    }),
  );
  it.effect.each(["0.0.0.0", "192.168.1.2", "remote.example"])(
    "rejects inherited non-loopback binding: %s",
    (host) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-config-" });
        const error = yield* Effect.flip(resolveServerConfig(flags(baseDir), Option.none())).pipe(
          Effect.provide(
            Layer.merge(
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_HOST: host } })),
              NetService.layer,
            ),
          ),
        );
        expect(error.message).toMatch(/loopback|explicit IPv4/);
      }),
  );
  it.effect.each([
    { source: "COX_AUTH_PASSWORD", env: { COX_AUTH_PASSWORD: " cox-password " } },
    { source: "the legacy name", env: { T3CODE_AUTH_PASSWORD: "cox-password" } },
    {
      source: "COX_AUTH_PASSWORD before the legacy name",
      env: { COX_AUTH_PASSWORD: "cox-password", T3CODE_AUTH_PASSWORD: "legacy-password" },
    },
  ])("reads the sign-in password from $source", ({ env }) =>
    resolveWithEnv(env).pipe(
      Effect.map((config) => {
        expect(config.authPassword && Redacted.value(config.authPassword)).toBe("cox-password");
        expect(config.host).toBe("127.0.0.1");
      }),
    ),
  );
  it.effect("validates the final CLI host rather than the environment host", () =>
    Effect.flip(
      resolveWithEnv({ T3CODE_HOST: "127.0.0.1" }, { host: Option.some("0.0.0.0") }),
    ).pipe(Effect.map((error) => expect(error.message).toContain("COX_AUTH_PASSWORD"))),
  );
  it.effect("allows a CLI loopback override without inheriting an external binding", () =>
    resolveWithEnv({ T3CODE_HOST: "0.0.0.0" }, { host: Option.some("127.0.0.1") }).pipe(
      Effect.map((config) => expect(config.host).toBe("127.0.0.1")),
    ),
  );
  it.effect("leaves password sign-in off without a password", () =>
    resolveWithEnv({}).pipe(
      Effect.map((config) => {
        expect(config.authPassword).toBeUndefined();
      }),
    ),
  );
  it.effect("rejects a sign-in password shorter than 8 characters", () =>
    Effect.flip(resolveWithEnv({ COX_AUTH_PASSWORD: "short" })).pipe(
      Effect.map((error) => {
        expect(String(error)).toContain("COX_AUTH_PASSWORD must contain at least 8 characters");
      }),
    ),
  );
  for (const host of ["0.0.0.0", "::", "192.168.1.2", "2001:db8::1"]) {
    it.effect("accepts numeric password-protected binding " + host, () =>
      resolveWithEnv({ T3CODE_HOST: host, COX_AUTH_PASSWORD: "cox-password" }).pipe(
        Effect.map((config) => expect(config.host).toBe(host)),
      ),
    );
    it.effect("rejects an unprotected binding " + host, () =>
      Effect.flip(validateListenHost(host)).pipe(
        Effect.map((error) => expect(error.message).toContain("COX_AUTH_PASSWORD")),
      ),
    );
  }
  it.effect("rejects an invalid injected password even on loopback", () =>
    Effect.flip(validateListenHost("127.0.0.1", Redacted.make("short"))).pipe(
      Effect.map((error) => expect(error.message).toContain("at least 8 characters")),
    ),
  );
  it.effect("rejects DNS bind names even with a password", () =>
    Effect.flip(validateListenHost("example.com", Redacted.make("cox-password"))).pipe(
      Effect.map((error) => expect(error.message).toContain("explicit IPv4/IPv6")),
    ),
  );
  for (const devUrl of [
    "http://192.168.1.2:5173",
    "http://user:secret@localhost:5173",
    "ftp://localhost:5173",
  ]) {
    it.effect("rejects unsafe development URL " + devUrl, () =>
      Effect.flip(
        resolveWithEnv({ VITE_DEV_SERVER_URL: devUrl, COX_AUTH_PASSWORD: "cox-password" }),
      ).pipe(Effect.map((error) => expect(error.message).toContain("loopback"))),
    );
  }
  it.effect("ignores the removed reusable development bypass", () =>
    resolveWithEnv({
      VITE_DEV_SERVER_URL: "http://localhost:5173",
      T3CODE_DEV_AUTH_TOKEN: "short",
    }).pipe(Effect.map((config) => expect(config).not.toHaveProperty("devAuthToken"))),
  );
  it.effect.each([{ COX_AUTH_PASSWORD: "cox-password" }, { T3CODE_AUTH_PASSWORD: "cox-password" }])(
    "resolves the same password policy for CLI session management: %j",
    (env) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-cli-auth-" });
        const config = yield* resolveCliAuthConfig(
          { baseDir: Option.some(baseDir) },
          Option.none(),
        ).pipe(
          Effect.provide(
            Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env })), NetService.layer),
          ),
        );
        expect(config.authPassword && Redacted.value(config.authPassword)).toBe("cox-password");
        expect(config.authPolicyReadOnly).toBe(true);
      }),
  );
  it.effect("marks CLI auth policy read-only without an inherited service password", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-cli-auth-readonly-" });
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        Option.none(),
      ).pipe(
        Effect.provide(
          Layer.merge(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })), NetService.layer),
        ),
      );
      expect(config.authPolicyReadOnly).toBe(true);
      expect(config.authPassword).toBeUndefined();
    }),
  );
});
