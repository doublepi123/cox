import {
  readMacUpdateTransaction,
  runMacUpdateTransaction,
  writeMacUpdateState,
  macUpdatePaths,
} from "./mac-update-transaction.ts";
import { launchMacApplication, verifyMacApplication } from "./mac-update-platform.ts";

const home = process.argv[2];
const id = process.argv[3];
if (process.platform !== "darwin" || !home || !id)
  throw new Error("The Cox macOS update helper requires a valid transaction.");
try {
  const transaction = await readMacUpdateTransaction(home, id);
  await runMacUpdateTransaction(home, id, {
    verify: (application, current) => verifyMacApplication(application, current, current.target),
    launch: (application, current) =>
      launchMacApplication(application, home, current, transaction.offline),
    ready: () => {
      if (process.connected) process.send?.("cox:mac-update-ready");
    },
  });
} catch (error) {
  if (process.connected) process.send?.({ type: "cox:mac-update-error", message: String(error) });
  const transaction = await readMacUpdateTransaction(home, id);
  await writeMacUpdateState(macUpdatePaths(home, id, transaction.target).directory, "status.json", {
    phase: "error",
    message: String(error),
  });
  process.exitCode = 1;
}
