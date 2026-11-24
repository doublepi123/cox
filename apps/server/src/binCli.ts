import { doctorCommand } from "./cli/doctor.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";

import * as NetService from "@t3tools/shared/Net";
import packageJson from "../package.json" with { type: "json" };
import { acpMcpBridgeCommand, acpMcpCallCommand } from "./cli/acpMcpBridge.ts";
import { authCommand } from "./cli/auth.ts";
import { browserCommand } from "./cli/browser.ts";
import { extendConnectionAttemptTimeout, keepOutboundFetchOnHttp1 } from "./outboundHttp.ts";
import { sharedServerCommandFlags } from "./cli/config.ts";
import { projectCommand } from "./cli/project.ts";
import { threadCommand } from "./cli/thread.ts";
import { workflowCommand } from "./cli/workflow.ts";
import { runDefaultServerCommand, serveCommand, startCommand } from "./cli/server.ts";
import { claudeHistoryCommand } from "./cli/claudeHistory.ts";
import { themeCommand } from "./cli/theme.ts";
import { traceCommand } from "./cli/trace.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

export const makeCli = () =>
  Command.make("cox", { ...sharedServerCommandFlags }).pipe(
    Command.withDescription("Run Cox locally and open it in your browser."),
    Command.withHandler(runDefaultServerCommand),
    Command.withSubcommands([
      acpMcpBridgeCommand,
      acpMcpCallCommand,
      startCommand,
      serveCommand,
      authCommand,
      browserCommand,
      projectCommand,
      threadCommand,
      workflowCommand,
      claudeHistoryCommand,
      themeCommand,
      traceCommand,
      doctorCommand,
    ]),
  );

export const cli = makeCli();

export function runCli() {
  extendConnectionAttemptTimeout();
  keepOutboundFetchOnHttp1();
  Command.run(cli, { version: packageJson.version }).pipe(
    Effect.scoped,
    Effect.provide(layerCliRuntime),
    NodeRuntime.runMain,
  );
}
