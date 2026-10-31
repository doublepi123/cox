import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

const shellWord = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";
const powershellWord = (value: string) =>
  '"' +
  value
    .replaceAll("`", "``")
    .replaceAll("$", "`$")
    .replace(/["\u201C\u201D\u201E]/g, "$&$&") +
  '"';

export const resolveEntryPath = Effect.gen(function* () {
  if (yield* HostProcess.IsExecutable) return yield* HostProcess.ExecutablePath;
  return (yield* HostProcess.Arguments)[1] ?? new URL("../bin.ts", import.meta.url).pathname;
});

export const resolveHostCliCommand = Effect.fn("invocation.resolveHostCliCommand")(function* (
  subcommand: string,
  args: ReadonlyArray<string> = [],
) {
  const platform = yield* HostProcess.Platform;
  const quote = platform === "win32" ? powershellWord : shellWord;
  const executable = yield* HostProcess.ExecutablePath;
  const standalone = yield* HostProcess.IsExecutable;
  const entry = yield* resolveEntryPath;
  const prefix = [executable, ...(standalone ? [] : [entry])].map(quote).join(" ");
  const command = [
    platform === "win32" ? "& " + prefix : prefix,
    subcommand,
    ...args.map(quote),
  ].join(" ");
  return { command, launcher: true };
});

export const resolveCliCommand = (subcommand: string) =>
  resolveHostCliCommand(subcommand).pipe(Effect.map(({ command }) => command));
export const resolveRootCliCommand = (subcommand: string, args: ReadonlyArray<string> = []) =>
  resolveHostCliCommand(subcommand, args).pipe(Effect.map(({ command }) => "sudo " + command));
