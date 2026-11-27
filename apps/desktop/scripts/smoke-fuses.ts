import assert from "node:assert/strict";
import { FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { FuseState } from "@electron/fuses/dist/constants.js";

export async function assertInspectorFuseDisabled(appPath: string): Promise<void> {
  const wire = await getCurrentFuseWire(appPath);
  assert.equal(wire.version, FuseVersion.V1, "Unexpected Electron fuse wire version.");
  assert.equal(
    wire[FuseV1Options.EnableNodeCliInspectArguments],
    FuseState.DISABLE,
    "Node inspector flags must be disabled in " + appPath,
  );
}
