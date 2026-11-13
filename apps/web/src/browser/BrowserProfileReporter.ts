import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthPreviewOperateScope, type EnvironmentId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { Atom } from "effect/reactivity";

import {
  getClientSettings,
  getClientSettingsHydratedSnapshot,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";
import { environmentSession, sessionHasScope } from "~/state/session";

export interface ProfileReport {
  readonly profiles: ClientSettings["browserProfiles"];
  readonly defaultProfileId: ClientSettings["browserDefaultProfileId"];
  readonly recordingFrameRate: ClientSettings["browserRecordingFrameRate"];
}

/** Server-browser environments this client may operate, with the config each currently runs. */
const reportTargetsAtom = Atom.make((get) => {
  const targets = new Map<EnvironmentId, EnvironmentServerConfig>();
  for (const [environmentId, config] of get(environmentPresentations.serverConfigsAtom)) {
    if (!config.environment.capabilities.serverBrowser) continue;
    const session = get(environmentSession.sessionStateAtom(environmentId));
    if (!sessionHasScope(session, AuthPreviewOperateScope)) continue;
    targets.set(environmentId, config);
  }
  return targets;
}).pipe(Atom.withLabel("browser-profile-report-targets"));

const REPORT_RETRY_DELAY_MS = 5_000;
const MAX_REPORT_ATTEMPTS = 3;

/**
 * Keeps every operable server browser on this client's profiles. An environment is reported
 * again when its server config changes (a restarted server has forgotten them), when it becomes
 * operable, and when the profile settings change.
 */
export function startBrowserProfileReporting(): () => void {
  const reported: ReportedProfiles = new Map();
  const retries = new Map<
    EnvironmentId,
    {
      readonly config: EnvironmentServerConfig;
      readonly input: ProfileReport;
      readonly failures: number;
    }
  >();
  const retryTimers = new Map<EnvironmentId, ReturnType<typeof setTimeout>>();
  const clearRetry = (environmentId: EnvironmentId) => {
    const timer = retryTimers.get(environmentId);
    if (timer !== undefined) clearTimeout(timer);
    retryTimers.delete(environmentId);
  };
  const report = () => {
    if (!getClientSettingsHydratedSnapshot()) return;
    const settings = getClientSettings();
    const input: ProfileReport = {
      profiles: settings.browserProfiles,
      defaultProfileId: settings.browserDefaultProfileId,
      recordingFrameRate: settings.browserRecordingFrameRate,
    };
    const targets = appAtomRegistry.get(reportTargetsAtom);
    for (const environmentId of takeDueProfileReports(reported, targets, input)) {
      const entry = reported.get(environmentId);
      if (entry === undefined) continue;
      clearRetry(environmentId);
      void runAtomCommand(
        appAtomRegistry,
        previewEnvironment.reportProfiles,
        { environmentId, input },
        { reportFailure: false },
      ).then((result) => {
        if (reported.get(environmentId) !== entry) return;
        if (result._tag === "Success") {
          retries.delete(environmentId);
          return;
        }
        reported.delete(environmentId);
        const previous = retries.get(environmentId);
        const failures =
          previous !== undefined &&
          previous.config === entry.config &&
          sameReportInput(previous.input, entry.input)
            ? previous.failures + 1
            : 1;
        if (failures >= MAX_REPORT_ATTEMPTS) {
          retries.delete(environmentId);
          return;
        }
        retries.set(environmentId, { config: entry.config, input: entry.input, failures });
        retryTimers.set(
          environmentId,
          setTimeout(() => {
            retryTimers.delete(environmentId);
            report();
          }, REPORT_RETRY_DELAY_MS),
        );
      });
    }
  };
  const unsubscribes = [
    appAtomRegistry.subscribe(reportTargetsAtom, report),
    subscribeClientSettings(report),
    subscribeClientSettingsHydration(report),
  ];
  report();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    retries.clear();
  };
}

export type ReportedProfiles = Map<
  EnvironmentId,
  { readonly config: EnvironmentServerConfig; readonly input: ProfileReport }
>;

/**
 * Returns the targets that need `input` reported and records them in `reported`. An
 * environment that dropped out of `targets` is forgotten, so it is reported again once it
 * becomes operable.
 */
export function takeDueProfileReports(
  reported: ReportedProfiles,
  targets: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
  input: ProfileReport,
): EnvironmentId[] {
  for (const environmentId of reported.keys()) {
    if (!targets.has(environmentId)) reported.delete(environmentId);
  }
  const due: EnvironmentId[] = [];
  for (const [environmentId, config] of targets) {
    const last = reported.get(environmentId);
    if (last && last.config === config && sameReportInput(last.input, input)) continue;
    reported.set(environmentId, { config, input });
    due.push(environmentId);
  }
  return due;
}

function sameReportInput(left: ProfileReport, right: ProfileReport): boolean {
  return (
    left.profiles === right.profiles &&
    left.defaultProfileId === right.defaultProfileId &&
    left.recordingFrameRate === right.recordingFrameRate
  );
}
