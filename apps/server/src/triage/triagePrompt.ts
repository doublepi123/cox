import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

export const TRIAGE_PLAYBOOK = `# Cox local diagnostics

Ask the user what went wrong and obtain reproduction steps. Read the supplied local context before investigating.
Inspect only the Cox checkout and its isolated state directory. Do not read or modify the original T3 installation or ~/.t3.
Use local server traces, provider event logs, and terminal logs to establish what happened. Never read secrets or print credentials.
Do not clone upstream source, download a playbook, create issues, start paid provider turns, or alter the running service without an explicit user request.
Preserve authentication and loopback binding. Give the user a concrete diagnosis and the smallest verifiable fix.
This session runs inside Cox: stopping its server ends the session. Ask the user to perform any necessary restart.`;

export type TriageEntry =
  | { readonly kind: "cli"; readonly cliVersion: string; readonly launchedAs: string }
  | { readonly kind: "app"; readonly client: string };
export const buildTriageLaunchPrompt = (promptFilePath: string) =>
  `Read the file "${promptFilePath}" and follow its local Cox diagnostics instructions.`;
export const buildTriageAppPrompt = (promptFilePath: string) =>
  `Read ${serializeComposerFileLink(promptFilePath)} and follow it. `;
export const buildTriageSeedPrompt = (input: {
  readonly contextFilePath: string;
  readonly entry: TriageEntry;
}) => `Read the local context at ${input.contextFilePath}.

${TRIAGE_PLAYBOOK}`;
export interface TriageContextInput {
  readonly generatedAt: string;
  readonly entry: TriageEntry;
  readonly os: string;
  readonly nodeVersion: string;
  readonly server: string;
  readonly paths: {
    readonly stateDir: string;
    readonly dbPath: string;
    readonly settingsPath: string;
    readonly logsDir: string;
    readonly serverTracePath: string;
    readonly providerEventLogPath: string;
    readonly terminalLogsDir: string;
    readonly providerStatusCacheDir: string;
    readonly secretsDir: string;
  };
}
export const buildTriageContext = (input: TriageContextInput) => `# Cox local diagnostics context
Generated at ${input.generatedAt}.
- OS: ${input.os}
- Node: ${input.nodeVersion}
- Server process: ${input.server}
- State dir: ${input.paths.stateDir}
- Database (read only while the server is running): ${input.paths.dbPath}
- Settings: ${input.paths.settingsPath}
- Logs dir: ${input.paths.logsDir}
- Server trace: ${input.paths.serverTracePath}
- Provider event log: ${input.paths.providerEventLogPath}
- Terminal logs: ${input.paths.terminalLogsDir}
- Provider status cache: ${input.paths.providerStatusCacheDir}
- Secrets dir (NEVER read this): ${input.paths.secretsDir}
`;
