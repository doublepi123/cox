import { PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createAllEnvironmentProjectSnapshotsReadyAtom } from "./shell";
import { environmentCatalog } from "../connection/catalog";
import { environmentUnreachableAtom } from "./presentation";

const LOCAL = EnvironmentId.make("local");

function shellState(status: EnvironmentShellState["status"]): EnvironmentShellState {
  return {
    ...EMPTY_SHELL_STATE,
    status,
    snapshot:
      status === "empty"
        ? Option.none()
        : Option.some({
            schemaVersion: 1,
            snapshotSequence: 1,
            projects: [],
            threads: [],
            archivedThreads: [],
          }),
    error: Option.none(),
  };
}

function catalogState(environmentIds: readonly EnvironmentId[]): EnvironmentCatalogState {
  return {
    isReady: true,
    entries: new Map(
      environmentIds.map((environmentId) => [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: environmentId,
            httpBaseUrl: `https://${environmentId}.example.test`,
            wsBaseUrl: `wss://${environmentId}.example.test`,
          }),
          profile: Option.none(),
          enabled: true,
        },
      ]),
    ),
  };
}

function makeHarness(requiresPrimaryEnvironment = true) {
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: false, entries: new Map() });
  const shells = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(shellState("empty")),
  );
  const ready = createAllEnvironmentProjectSnapshotsReadyAtom({
    catalogValueAtom: catalog,
    shellStateValueAtom: shells,
    requiresPrimaryEnvironment,
  });
  const registry = AtomRegistry.make();
  return { catalog, shells, ready, registry };
}

it("calls an environment unreachable only when primary discovery proves it absent", () => {
  const unknown = EnvironmentId.make("unknown");
  const unreachable = (environmentIds: readonly EnvironmentId[], id: EnvironmentId) => {
    const registry = AtomRegistry.make({
      initialValues: [[environmentCatalog.catalogValueAtom, catalogState(environmentIds)]],
    });
    try {
      return registry.get(environmentUnreachableAtom(id));
    } finally {
      registry.dispose();
    }
  };
  expect(unreachable([], unknown)).toBe(false);
  expect(unreachable([LOCAL], unknown)).toBe(true);
  expect(unreachable([LOCAL], LOCAL)).toBe(false);
});

describe("project snapshot readiness", () => {
  it("does not clear a saved scope while the ready catalog is still empty", () => {
    const { catalog, ready, registry } = makeHarness();
    expect(registry.get(ready)).toBe(false);
    registry.set(catalog, catalogState([]));
    expect(registry.get(ready)).toBe(false);
    registry.dispose();
  });

  it("waits for live snapshots through offline startup and reconnect", () => {
    const { catalog, shells, ready, registry } = makeHarness();
    registry.set(catalog, catalogState([LOCAL]));
    expect(registry.get(ready)).toBe(false);

    registry.set(shells(LOCAL), shellState("cached"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(LOCAL), shellState("synchronizing"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(LOCAL), shellState("live"));
    expect(registry.get(ready)).toBe(true);

    registry.set(shells(LOCAL), shellState("cached"));
    expect(registry.get(ready)).toBe(false);
    registry.set(shells(LOCAL), shellState("live"));
    expect(registry.get(ready)).toBe(true);
    registry.dispose();
  });

  it("does not treat a disconnected catalog as an empty project snapshot", () => {
    const { catalog, ready, registry } = makeHarness();
    registry.set(catalog, catalogState([]));
    expect(registry.get(ready)).toBe(false);
    registry.dispose();
  });
});
