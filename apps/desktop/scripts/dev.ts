import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const electron: unknown = createRequire(import.meta.url)("electron");
if (typeof electron !== "string") throw new Error("The Electron executable is not installed.");
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, COX_DESKTOP_NODE: process.execPath },
});
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
