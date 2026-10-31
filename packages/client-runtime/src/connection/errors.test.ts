import { expect, it } from "vite-plus/test";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { target } from "./localTestFixtures.ts";
import { EnvironmentId } from "@t3tools/contracts";
it("maps an unreachable local server to a retriable failure", () => {
  expect(
    mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({
        message: "Offline",
        cause: new TypeError("fetch failed"),
      }),
    ),
  ).toMatchObject({ _tag: "ConnectionTransientError", reason: "network", hop: "server" });
});
it("blocks a changed server identity", () => {
  expect(
    environmentMismatchError({
      expected: target.environmentId,
      actual: EnvironmentId.make("other"),
    }),
  ).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
});
