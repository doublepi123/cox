// @effect-diagnostics nodeBuiltinImport:off
import * as Schema from "effect/Schema";
import { readFile, realpath } from "node:fs/promises";
import type { LocalServiceUpdatePlan } from "./operation.ts";
import { updateEnvironment } from "./ownership.ts";
import { runLocalServiceCommand } from "./process.ts";

const systemd = "org.freedesktop.systemd1";
const decodeUnit = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literal("o"), data: Schema.Tuple([Schema.String]) }),
  ),
);
const decodeDropIns = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({ type: Schema.Literal("as"), data: Schema.Array(Schema.String) }),
  ),
);
const decodeExecStart = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.Literal("a(sasbttttuii)"),
      data: Schema.Array(
        Schema.TupleWithRest(Schema.Tuple([Schema.String, Schema.Array(Schema.String)]), [
          Schema.Unknown,
        ]),
      ),
    }),
  ),
);

class SystemdUpdateError extends Error {
  override readonly name = "SystemdUpdateError";
}

function renderExecStart(args: readonly string[]): string {
  const command = args.map((arg) => JSON.stringify(arg.replaceAll("%", "%%")));
  return "[Service]\nExecStart=\nExecStart=" + command.join(" ") + "\n";
}

export function renderLocalServiceDropIn(args: readonly string[]): string {
  return renderExecStart(args.map((arg) => arg.replaceAll("$", () => "$$")));
}

export async function verifyLocalServiceSystemdUpdate(
  plan: Pick<LocalServiceUpdatePlan, "serviceUnit" | "dropIn" | "node" | "nextUnit">,
): Promise<void> {
  const bus = (args: readonly string[]) =>
    runLocalServiceCommand("busctl", ["--user", "--json=short", ...args], {
      env: updateEnvironment(process.env),
      timeout: 5_000,
    });
  const {
    data: [unit],
  } = decodeUnit(
    await bus([
      "call",
      systemd,
      "/org/freedesktop/systemd1",
      systemd + ".Manager",
      "GetUnit",
      "s",
      plan.serviceUnit,
    ]),
  );
  const { data: dropIns } = decodeDropIns(
    await bus(["get-property", systemd, unit, systemd + ".Unit", "DropInPaths"]),
  );
  const plannedDropIn = await realpath(plan.dropIn);
  const loadedDropIns = await Promise.all(dropIns.map((path) => realpath(path)));
  const updateIndex = loadedDropIns.indexOf(plannedDropIn);
  if (updateIndex === -1)
    throw new SystemdUpdateError("The systemd user manager did not load the Cox update override.");

  const { data: commands } = decodeExecStart(
    await bus(["get-property", systemd, unit, systemd + ".Service", "ExecStart"]),
  );
  const command = commands[0];
  if (
    commands.length === 1 &&
    command?.[0] === plan.node &&
    renderExecStart(command[1]) === plan.nextUnit
  )
    return;

  const conflicts: string[] = [];
  for (const path of dropIns.slice(updateIndex + 1)) {
    let section = "";
    for (const line of (await readFile(path, "utf8")).replaceAll(/\\\r?\n/g, " ").split(/\r?\n/)) {
      const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
      if (heading) section = heading[1] ?? "";
      if (section === "Service" && /^\s*ExecStart\s*=/.test(line)) {
        conflicts.push(path);
        break;
      }
    }
  }
  throw new SystemdUpdateError(
    "The effective systemd ExecStart does not match the staged Cox update." +
      (conflicts.length ? " Conflicting drop-in files: " + conflicts.join(", ") + "." : ""),
  );
}
