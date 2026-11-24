import type { ProjectFaviconTarget } from "@t3tools/client-runtime/project-favicon-cache";
import {
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
} from "@t3tools/client-runtime/state/assets";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconCache } from "../assets/projectFaviconCache";
import { appAtomRegistry } from "../rpc/atomRegistry";

import { environmentProjectClonesAtom } from "./projectClones";
import { environmentSession } from "./session";
const localMediaEnvironment = Atom.make(null);
export const assetEnvironment = createAssetEnvironmentAtoms(
  connectionAtomRuntime,
  localMediaEnvironment,
);
export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectClonesAtom,
});

export function refreshProjectFaviconUrl(target: ProjectFaviconTarget) {
  appAtomRegistry.refresh(
    assetEnvironment.createUrl({
      environmentId: target.environmentId,
      input: {
        resource: {
          _tag: "project-favicon",
          cwd: target.cwd,
          ...(target.faviconPath ? { path: target.faviconPath } : {}),
        },
      },
    }),
  );
}
