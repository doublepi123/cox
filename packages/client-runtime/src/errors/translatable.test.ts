import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import { squashAtomCommandFailure } from "../state/runtime.ts";

const decodeDefect = Schema.decodeUnknownSync(Schema.Defect());

describe("squashAtomCommandFailure", () => {
  it("shows the text of a string defect that came back over RPC", () => {
    const defect = decodeDefect(
      "RPC contract is registered but unavailable in the control plane: projectClone.start",
    );
    const error = squashAtomCommandFailure({ cause: Cause.die(defect) });

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message:
        "RPC contract is registered but unavailable in the control plane: projectClone.start",
    });
  });
});
